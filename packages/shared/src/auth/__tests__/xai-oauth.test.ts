import { afterEach, describe, expect, it } from 'bun:test'
import { exchangeXaiTokens, prepareXaiOAuth, refreshXaiTokens } from '../xai-oauth.ts'
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
})
