/**
 * Shared OAuth configuration for xAI/Grok subscription authentication.
 *
 * The client id/scope/loopback callback match the public Grok CLI/OpenClaw-style
 * xAI OAuth flow used by pi-xai-oauth. Craft stores the resulting OAuth token
 * in llm_oauth and passes the structured credential to Pi's xai-auth provider.
 */

export const XAI_OAUTH_CONFIG = {
  CLIENT_ID: 'b1a00492-073a-47ea-816f-4c329264a828',
  DISCOVERY_URL: 'https://auth.x.ai/.well-known/openid-configuration',
  CALLBACK_HOST: '127.0.0.1',
  CALLBACK_PORT: 56121,
  CALLBACK_PATH: '/callback',
  SCOPES: 'openid profile email offline_access grok-cli:access api:access',
  TOKEN_EXPIRY_SKEW_MS: 2 * 60 * 1000,
} as const;

export type XaiOAuthConfig = typeof XAI_OAUTH_CONFIG;
