import { describe, expect, it } from 'bun:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  createXaiProviderExtension,
  type XaiOAuthCredential,
} from './xai-provider-extension.ts';

describe('xAI provider OAuth refresh bridge', () => {
  it('delegates refresh to the Craft main-process handler', async () => {
    let registeredProvider = '';
    let registeredConfig: any;
    const seen: XaiOAuthCredential[] = [];
    const extension = createXaiProviderExtension(async (credentials) => {
      seen.push(credentials);
      return {
        access: 'access-1',
        refresh: 'refresh-1',
        expires: 123_456,
        idToken: 'id-1',
      };
    });

    extension({
      registerProvider(provider: string, config: unknown) {
        registeredProvider = provider;
        registeredConfig = config;
      },
    } as unknown as ExtensionAPI);

    const current: XaiOAuthCredential = {
      access: 'access-0',
      refresh: 'refresh-0',
      expires: 1,
    };
    const refreshed = await registeredConfig.oauth.refreshToken(current);

    expect(registeredProvider).toBe('xai-auth');
    expect(seen).toEqual([current]);
    expect(refreshed).toEqual({
      access: 'access-1',
      refresh: 'refresh-1',
      expires: 123_456,
      idToken: 'id-1',
    });
  });
});
