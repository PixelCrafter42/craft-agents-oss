/**
 * xAI OAuth with PKCE.
 *
 * Server-owned flow:
 *   - prepareXaiOAuth() builds state, PKCE, discovery-backed auth URL
 *   - the Electron preload opens a local callback server + browser
 *   - exchangeXaiTokens() stores tokens in llm_oauth
 *   - refreshXaiTokens() refreshes expired access tokens
 */

import { createHash, randomBytes } from 'node:crypto';
import { XAI_OAUTH_CONFIG } from './xai-oauth-config.ts';

export interface XaiTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  idToken?: string;
}

export interface XaiOAuthCredentialStore {
  getLlmOAuth(connectionSlug: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    idToken?: string;
  } | null>;
  setLlmOAuth(connectionSlug: string, credentials: XaiTokens): Promise<void>;
}

export interface XaiPreparedFlow {
  authUrl: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  tokenEndpoint: string;
}

interface XaiDiscoveryDocument {
  authorization_endpoint?: string;
  token_endpoint?: string;
}

interface XaiTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  error?: string;
  error_description?: string;
}

const storedRefreshes = new WeakMap<
  object,
  Map<string, Promise<XaiTokens>>
>();

function generateState(): string {
  return randomBytes(32).toString('hex');
}

function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

function validateXaiHttpsEndpoint(value: string | undefined, label: string): string {
  if (!value) throw new Error(`xAI OAuth discovery did not include ${label}`);
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:') {
    throw new Error(`xAI OAuth ${label} must use https`);
  }
  if (parsed.hostname !== 'auth.x.ai' && !parsed.hostname.endsWith('.x.ai')) {
    throw new Error(`xAI OAuth ${label} has unexpected host: ${parsed.hostname}`);
  }
  return parsed.toString();
}

async function fetchDiscovery(): Promise<{ authorizationEndpoint: string; tokenEndpoint: string }> {
  const response = await fetch(XAI_OAUTH_CONFIG.DISCOVERY_URL, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`xAI OAuth discovery failed: HTTP ${response.status}`);
  }

  const document = (await response.json()) as XaiDiscoveryDocument;
  return {
    authorizationEndpoint: validateXaiHttpsEndpoint(document.authorization_endpoint, 'authorization endpoint'),
    tokenEndpoint: validateXaiHttpsEndpoint(document.token_endpoint, 'token endpoint'),
  };
}

function expiresAtFromSeconds(expiresIn: number | undefined): number | undefined {
  if (!expiresIn || expiresIn <= 0) return undefined;
  return Date.now() + expiresIn * 1000 - XAI_OAUTH_CONFIG.TOKEN_EXPIRY_SKEW_MS;
}

function parseTokenError(status: number, text: string): string {
  try {
    const data = JSON.parse(text) as XaiTokenResponse;
    return data.error_description || data.error || text;
  } catch {
    return text;
  }
}

function normalizeTokenResponse(data: XaiTokenResponse, fallbackRefreshToken?: string): XaiTokens {
  if (!data.access_token) {
    throw new Error('xAI OAuth token response did not include an access token');
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || fallbackRefreshToken,
    expiresAt: expiresAtFromSeconds(data.expires_in),
    idToken: data.id_token,
  };
}

export async function prepareXaiOAuth(redirectUri: string): Promise<XaiPreparedFlow> {
  const { authorizationEndpoint, tokenEndpoint } = await fetchDiscovery();
  const state = generateState();
  const { codeVerifier, codeChallenge } = generatePKCE();

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: XAI_OAUTH_CONFIG.CLIENT_ID,
    redirect_uri: redirectUri,
    scope: XAI_OAUTH_CONFIG.SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce: randomBytes(16).toString('hex'),
  });

  return {
    authUrl: `${authorizationEndpoint}?${params.toString()}`,
    state,
    codeVerifier,
    redirectUri,
    tokenEndpoint,
  };
}

export async function exchangeXaiTokens(args: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  tokenEndpoint: string;
}): Promise<XaiTokens> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: XAI_OAUTH_CONFIG.CLIENT_ID,
    code: args.code,
    redirect_uri: args.redirectUri,
    code_verifier: args.codeVerifier,
  });

  const response = await fetch(args.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`xAI OAuth token exchange failed: HTTP ${response.status} - ${parseTokenError(response.status, text)}`);
  }

  return normalizeTokenResponse(JSON.parse(text) as XaiTokenResponse);
}

export async function refreshXaiTokens(
  refreshToken: string,
  onStatus?: (message: string) => void,
): Promise<XaiTokens> {
  onStatus?.('Refreshing xAI tokens...');
  const { tokenEndpoint } = await fetchDiscovery();
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: XAI_OAUTH_CONFIG.CLIENT_ID,
    refresh_token: refreshToken,
  });

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`xAI OAuth token refresh failed: HTTP ${response.status} - ${parseTokenError(response.status, text)}`);
  }

  onStatus?.('xAI tokens refreshed successfully');
  return normalizeTokenResponse(JSON.parse(text) as XaiTokenResponse, refreshToken);
}

/**
 * Refresh and persist a stored xAI credential as one serialized operation.
 *
 * xAI rotates refresh tokens, so every caller that owns a durable Craft
 * connection must share this path. The optional expected token lets a Pi
 * subprocess report which credential it observed; if another session or the
 * Settings validator already rotated it, the newer stored credential is
 * returned instead of replaying the stale token.
 */
export async function refreshStoredXaiTokens(
  credentialStore: XaiOAuthCredentialStore,
  connectionSlug: string,
  expectedRefreshToken?: string,
): Promise<XaiTokens> {
  const storeKey = credentialStore as object;
  let storeRefreshes = storedRefreshes.get(storeKey);
  if (!storeRefreshes) {
    storeRefreshes = new Map();
    storedRefreshes.set(storeKey, storeRefreshes);
  }

  const inFlight = storeRefreshes.get(connectionSlug);
  if (inFlight) {
    return inFlight;
  }

  const refreshPromise = (async (): Promise<XaiTokens> => {
    const stored = await credentialStore.getLlmOAuth(connectionSlug);
    if (!stored?.refreshToken) {
      throw new Error('No xAI OAuth refresh token found. Please re-authenticate.');
    }

    // A different caller already rotated the credential after this subprocess
    // took its snapshot. Returning the current pair avoids refresh-token reuse,
    // which can revoke the entire active token family.
    if (expectedRefreshToken && stored.refreshToken !== expectedRefreshToken) {
      return stored;
    }

    const refreshTokenUsed = stored.refreshToken;
    const refreshed = await refreshXaiTokens(refreshTokenUsed);
    const latest = await credentialStore.getLlmOAuth(connectionSlug);
    if (!latest?.refreshToken) {
      throw new Error('xAI OAuth credentials changed while refreshing. Please retry.');
    }
    if (latest.refreshToken !== refreshTokenUsed) {
      return latest;
    }

    const next: XaiTokens = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken || refreshTokenUsed,
      expiresAt: refreshed.expiresAt,
      idToken: refreshed.idToken || latest.idToken,
    };
    await credentialStore.setLlmOAuth(connectionSlug, next);
    return next;
  })();

  storeRefreshes.set(connectionSlug, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    if (storeRefreshes.get(connectionSlug) === refreshPromise) {
      storeRefreshes.delete(connectionSlug);
    }
  }
}
