import { afterEach, describe, expect, it } from 'bun:test';
import { XAI_OAUTH_CONFIG } from '../../../../auth/xai-oauth-config.ts';
import type { CredentialManager } from '../../../../credentials/manager.ts';
import type { LlmConnection } from '../../../../config/storage.ts';
import { piDriver } from './pi.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function xaiConnection(): LlmConnection {
  return {
    slug: 'xai-grok',
    name: 'xAI Grok',
    providerType: 'pi',
    authType: 'oauth',
    piAuthProvider: 'xai-auth',
    defaultModel: 'pi/grok-4.5',
    createdAt: Date.now(),
  };
}

function validationArgs(credentialManager: CredentialManager) {
  return {
    slug: 'xai-grok',
    connection: xaiConnection(),
    credentialManager,
    hostRuntime: {
      appRootPath: process.cwd(),
      isPackaged: false,
    },
    resolvedPaths: {
      nodeRuntimePath: process.execPath,
    },
  };
}

describe('Pi xAI stored-connection validation', () => {
  it('refreshes xAI OAuth credentials and persists rotated tokens', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const credentialManager = {
      getLlmOAuth: async () => ({
        accessToken: 'expired-access',
        refreshToken: 'current-refresh',
        expiresAt: Date.now() - 60_000,
        idToken: 'existing-id-token',
      }),
      setLlmOAuth: async (_slug: string, credentials: Record<string, unknown>) => {
        writes.push(credentials);
      },
    } as unknown as CredentialManager;

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url === XAI_OAUTH_CONFIG.DISCOVERY_URL) {
        return Response.json({
          authorization_endpoint: 'https://auth.x.ai/authorize',
          token_endpoint: 'https://auth.x.ai/oauth/token',
        });
      }

      expect(url).toBe('https://auth.x.ai/oauth/token');
      expect(String(init?.body)).toContain('refresh_token=current-refresh');
      return Response.json({
        access_token: 'fresh-access',
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
      });
    }) as typeof fetch;

    const result = await piDriver.validateStoredConnection!(validationArgs(credentialManager));

    expect(result).toEqual({ success: true });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      accessToken: 'fresh-access',
      refreshToken: 'rotated-refresh',
      idToken: 'existing-id-token',
    });
    expect(typeof writes[0]?.expiresAt).toBe('number');
  });

  it('fails validation when xAI reports that the refresh token was revoked', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const credentialManager = {
      getLlmOAuth: async () => ({
        accessToken: 'expired-access',
        refreshToken: 'revoked-refresh',
        expiresAt: Date.now() - 60_000,
      }),
      setLlmOAuth: async (_slug: string, credentials: Record<string, unknown>) => {
        writes.push(credentials);
      },
    } as unknown as CredentialManager;

    globalThis.fetch = (async (input) => {
      if (String(input) === XAI_OAUTH_CONFIG.DISCOVERY_URL) {
        return Response.json({
          authorization_endpoint: 'https://auth.x.ai/authorize',
          token_endpoint: 'https://auth.x.ai/oauth/token',
        });
      }

      return Response.json(
        {
          error: 'invalid_grant',
          error_description: 'Refresh token has been revoked',
        },
        { status: 400 },
      );
    }) as typeof fetch;

    const result = await piDriver.validateStoredConnection!(validationArgs(credentialManager));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Refresh token has been revoked');
    expect(writes).toHaveLength(0);
  });
});
