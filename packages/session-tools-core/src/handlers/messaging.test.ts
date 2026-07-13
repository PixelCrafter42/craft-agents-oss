import { describe, expect, it } from 'bun:test';
import type {
  ListMessagingSessionsOptions,
  SessionToolContext,
} from '../context.ts';
import { handleListMessagingSessions } from './messaging.ts';

describe('handleListMessagingSessions', () => {
  it('passes platform search and pagination to the workspace lookup', async () => {
    const calls: Array<ListMessagingSessionsOptions | undefined> = [];
    const ctx = {
      sessionId: 'automation-requester',
      listMessagingSessions: (options?: ListMessagingSessionsOptions) => {
        calls.push(options);
        return {
          total: 1,
          returned: 1,
          sessions: [{
            id: 'telegram-target',
            name: 'Ops Telegram',
            labels: ['ops'],
            status: 'todo',
            createdAt: 1,
            updatedAt: 2,
            bindings: [{
              bindingId: 'binding-1',
              platform: 'telegram' as const,
              channelId: '-1001',
              channelName: 'Ops › Alerts',
              threadId: 7,
              boundAt: 3,
            }],
          }],
        };
      },
    } as unknown as SessionToolContext;

    const result = await handleListMessagingSessions(ctx, {
      platform: 'telegram',
      search: 'ops',
      limit: 10,
      offset: 1,
    });

    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([{
      platform: 'telegram',
      search: 'ops',
      limit: 10,
      offset: 1,
    }]);
    expect(result.content[0]?.text).toContain('telegram-target');
    expect(result.content[0]?.text).toContain('binding-1');
    expect(result.content[0]?.text).toContain('"threadId": 7');
  });

  it('returns an explicit unavailable error when no workspace lookup is installed', async () => {
    const ctx = { sessionId: 'standalone' } as unknown as SessionToolContext;
    const result = await handleListMessagingSessions(ctx, { platform: 'weixin' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('not available in this context');
  });

  it('converts provider failures into tool errors', async () => {
    const ctx = {
      sessionId: 'automation-requester',
      listMessagingSessions: () => {
        throw new Error('binding store unavailable');
      },
    } as unknown as SessionToolContext;

    const result = await handleListMessagingSessions(ctx, {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('binding store unavailable');
  });
});
