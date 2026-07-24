import { afterEach, describe, expect, it } from 'bun:test'
import {
  exchangeXaiTokens,
  prepareXaiOAuth,
  refreshStoredXaiTokens,
  refreshXaiTokens,
  type XaiOAuthCredentialStore,
  type XaiTokens,
} from '../xai-oauth.ts'
import { XAI_OAUTH_CONFIG } from '../xai-oauth-config.ts'

const originalFetch = globalThis.fetch
const originalDateNow = Date.now

afterEach(() => {
  globalThis.fetch = originalFetch
  Date.now = originalDateNow
})

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

describe('xAI OAuth', () => {
  it('prepares discovery-backed PKCE authorization URL', async () => {
    globalThis.fetch = (async () => jsonResponse({
      authorization_endpoint: 'https://auth.x.ai/oauth/authorize',
      token_endpoint: 'https://auth.x.ai/oauth/token',
    })) as unknown as typeof fetch

    const flow = await prepareXaiOAuth('http://127.0.0.1:56121/callback')
    const url = new URL(flow.authUrl)

    expect(url.origin + url.pathname).toBe('https://auth.x.ai/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe(XAI_OAUTH_CONFIG.CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:56121/callback')
    expect(url.searchParams.get('scope')).toBe(XAI_OAUTH_CONFIG.SCOPES)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(flow.tokenEndpoint).toBe('https://auth.x.ai/oauth/token')
    expect(flow.state.length).toBeGreaterThan(20)
    expect(flow.codeVerifier.length).toBeGreaterThan(20)
  })

  it('exchanges authorization code for llm_oauth-compatible tokens', async () => {
    Date.now = () => 1_000_000
    let postedBody = ''
    globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      postedBody = String(init?.body)
      return jsonResponse({
        access_token: 'xai-access',
        refresh_token: 'xai-refresh',
        expires_in: 3600,
        id_token: 'xai-id',
      })
    }) as unknown as typeof fetch

    const tokens = await exchangeXaiTokens({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: 'http://127.0.0.1:56121/callback',
      tokenEndpoint: 'https://auth.x.ai/oauth/token',
    })

    const form = new URLSearchParams(postedBody)
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code')).toBe('auth-code')
    expect(form.get('code_verifier')).toBe('verifier')
    expect(tokens).toEqual({
      accessToken: 'xai-access',
      refreshToken: 'xai-refresh',
      expiresAt: 1_000_000 + 3600 * 1000 - XAI_OAUTH_CONFIG.TOKEN_EXPIRY_SKEW_MS,
      idToken: 'xai-id',
    })
  })

  it('refreshes tokens and preserves existing refresh token when none is returned', async () => {
    Date.now = () => 2_000_000
    const urls: string[] = []
    const bodies: string[] = []
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      urls.push(String(url))
      if (String(url) === XAI_OAUTH_CONFIG.DISCOVERY_URL) {
        return jsonResponse({
          authorization_endpoint: 'https://auth.x.ai/oauth/authorize',
          token_endpoint: 'https://auth.x.ai/oauth/token',
        })
      }
      bodies.push(String(init?.body))
      return jsonResponse({
        access_token: 'new-access',
        expires_in: 120,
      })
    }) as unknown as typeof fetch

    const tokens = await refreshXaiTokens('existing-refresh')

    expect(urls).toEqual([
      XAI_OAUTH_CONFIG.DISCOVERY_URL,
      'https://auth.x.ai/oauth/token',
    ])
    expect(new URLSearchParams(bodies[0]).get('grant_type')).toBe('refresh_token')
    expect(tokens.refreshToken).toBe('existing-refresh')
    expect(tokens.accessToken).toBe('new-access')
  })

  it('serializes stored refreshes and persists the rotated token once', async () => {
    let stored: XaiTokens = {
      accessToken: 'expired-access',
      refreshToken: 'refresh-0',
      expiresAt: 0,
      idToken: 'existing-id',
    }
    let tokenRequests = 0
    let writes = 0
    const credentialStore: XaiOAuthCredentialStore = {
      getLlmOAuth: async () => stored,
      setLlmOAuth: async (_slug, credentials) => {
        writes++
        stored = credentials
      },
    }

    globalThis.fetch = (async (url) => {
      if (String(url) === XAI_OAUTH_CONFIG.DISCOVERY_URL) {
        return jsonResponse({
          authorization_endpoint: 'https://auth.x.ai/oauth/authorize',
          token_endpoint: 'https://auth.x.ai/oauth/token',
        })
      }
      tokenRequests++
      return jsonResponse({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
      })
    }) as typeof fetch

    const [first, second] = await Promise.all([
      refreshStoredXaiTokens(credentialStore, 'xai-grok', 'refresh-0'),
      refreshStoredXaiTokens(credentialStore, 'xai-grok', 'refresh-0'),
    ])

    expect(tokenRequests).toBe(1)
    expect(writes).toBe(1)
    expect(first.refreshToken).toBe('refresh-1')
    expect(second.refreshToken).toBe('refresh-1')
    expect(stored).toMatchObject({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      idToken: 'existing-id',
    })
  })

  it('adopts a newer stored token instead of replaying a stale refresh token', async () => {
    const stored: XaiTokens = {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: Date.now() + 60_000,
    }
    let fetchCalls = 0
    let writes = 0
    const credentialStore: XaiOAuthCredentialStore = {
      getLlmOAuth: async () => stored,
      setLlmOAuth: async () => {
        writes++
      },
    }
    globalThis.fetch = (async () => {
      fetchCalls++
      throw new Error('stale refresh must not reach xAI')
    }) as unknown as typeof fetch

    const result = await refreshStoredXaiTokens(
      credentialStore,
      'xai-grok',
      'refresh-0',
    )

    expect(result).toEqual(stored)
    expect(fetchCalls).toBe(0)
    expect(writes).toBe(0)
  })

  it('does not overwrite a newer login that lands while refresh is in flight', async () => {
    const before: XaiTokens = {
      accessToken: 'access-0',
      refreshToken: 'refresh-0',
      expiresAt: 0,
    }
    const newerLogin: XaiTokens = {
      accessToken: 'access-login',
      refreshToken: 'refresh-login',
      expiresAt: Date.now() + 60_000,
    }
    let reads = 0
    let writes = 0
    const credentialStore: XaiOAuthCredentialStore = {
      getLlmOAuth: async () => (++reads === 1 ? before : newerLogin),
      setLlmOAuth: async () => {
        writes++
      },
    }
    globalThis.fetch = (async (url) => {
      if (String(url) === XAI_OAUTH_CONFIG.DISCOVERY_URL) {
        return jsonResponse({
          authorization_endpoint: 'https://auth.x.ai/oauth/authorize',
          token_endpoint: 'https://auth.x.ai/oauth/token',
        })
      }
      return jsonResponse({
        access_token: 'access-refreshed-old-grant',
        refresh_token: 'refresh-refreshed-old-grant',
        expires_in: 3600,
      })
    }) as typeof fetch

    const result = await refreshStoredXaiTokens(
      credentialStore,
      'xai-grok',
      'refresh-0',
    )

    expect(result).toEqual(newerLogin)
    expect(writes).toBe(0)
  })
})
