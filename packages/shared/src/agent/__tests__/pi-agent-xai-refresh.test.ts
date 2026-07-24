import { describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

function createConfig(sessionId: string, connectionSlug = 'xai-grok'): BackendConfig {
  return {
    provider: 'pi',
    providerType: 'pi',
    authType: 'oauth',
    connectionSlug,
    runtime: { piAuthProvider: 'xai-auth' },
    workspace: {
      id: 'ws-xai-refresh',
      name: 'xAI Test Workspace',
      rootPath: '/tmp/craft-agent-xai-refresh',
    } as any,
    session: {
      id: sessionId,
      workspaceRootPath: '/tmp/craft-agent-xai-refresh',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
  };
}

async function flushAsyncHandler(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('PiAgent xAI OAuth refresh bridge', () => {
  it('answers a subprocess refresh request with the main-process credential', async () => {
    const agent = new PiAgent(createConfig('session-request'));
    const sent: Array<Record<string, unknown>> = [];
    let expectedRefreshToken = '';

    (agent as any).send = (message: Record<string, unknown>) => {
      sent.push(message);
    };
    (agent as any).refreshAndPushTokens = async (expected: string) => {
      expectedRefreshToken = expected;
    };
    (agent as any).getPiAuth = async () => ({
      provider: 'xai-auth',
      credential: {
        type: 'oauth',
        access: 'access-1',
        refresh: 'refresh-1',
        expires: 123_456,
        idToken: 'id-1',
      },
    });

    (agent as any).handleLine(JSON.stringify({
      type: 'oauth_refresh_request',
      requestId: 'refresh-request-1',
      provider: 'xai-auth',
      expectedRefreshToken: 'refresh-0',
    }));
    await flushAsyncHandler();

    expect(expectedRefreshToken).toBe('refresh-0');
    expect(sent).toEqual([{
      type: 'oauth_refresh_result',
      requestId: 'refresh-request-1',
      success: true,
      credential: {
        type: 'oauth',
        access: 'access-1',
        refresh: 'refresh-1',
        expires: 123_456,
        idToken: 'id-1',
      },
    }]);

    agent.destroy();
  });

  it('broadcasts a rotated credential only to live sessions on the same connection', async () => {
    const first = new PiAgent(createConfig('session-first'));
    const sibling = new PiAgent(createConfig('session-sibling'));
    const otherConnection = new PiAgent(createConfig('session-other', 'other-xai'));
    const firstMessages: Array<Record<string, unknown>> = [];
    const siblingMessages: Array<Record<string, unknown>> = [];
    const otherMessages: Array<Record<string, unknown>> = [];
    const piAuth = {
      provider: 'xai-auth',
      credential: {
        type: 'oauth',
        access: 'access-1',
        refresh: 'refresh-1',
        expires: 123_456,
      },
    };

    (first as any).getPiAuth = async () => piAuth;
    for (const [agent, messages] of [
      [first, firstMessages],
      [sibling, siblingMessages],
      [otherConnection, otherMessages],
    ] as const) {
      (agent as any).subprocess = {};
      (agent as any).send = (message: Record<string, unknown>) => {
        messages.push(message);
      };
    }

    await (first as any).broadcastCurrentPiAuth();

    expect(firstMessages).toEqual([{ type: 'token_update', piAuth }]);
    expect(siblingMessages).toEqual([{ type: 'token_update', piAuth }]);
    expect(otherMessages).toEqual([]);

    (first as any).subprocess = null;
    (sibling as any).subprocess = null;
    (otherConnection as any).subprocess = null;
    first.destroy();
    sibling.destroy();
    otherConnection.destroy();
  });
});
