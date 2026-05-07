import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { SendMessagingFileRequest, SessionToolContext } from '../context.ts';
import { handleSendMessagingFile } from './send-messaging-file.ts';

function makeContext(overrides: Partial<SessionToolContext> = {}): SessionToolContext {
  return {
    sessionId: 'sess-1',
    workspacePath: tmpdir(),
    get sourcesPath() {
      return resolve(tmpdir(), 'sources');
    },
    get skillsPath() {
      return resolve(tmpdir(), 'skills');
    },
    plansFolderPath: resolve(tmpdir(), 'plans'),
    callbacks: {
      onPlanSubmitted() {},
      onAuthRequest() {},
    },
    fs: {} as SessionToolContext['fs'],
    ...overrides,
  } as SessionToolContext;
}

describe('handleSendMessagingFile', () => {
  it('returns a clear error when messaging file sending is unavailable', async () => {
    const result = await handleSendMessagingFile(makeContext(), { path: 'report.txt' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('send_messaging_file is not available');
  });

  it('resolves relative paths from the working directory and forwards target options', async () => {
    const workingDirectory = resolve(tmpdir(), 'messaging-file-test');
    const calls: SendMessagingFileRequest[] = [];
    const ctx = makeContext({
      workingDirectory,
      sendMessagingFile: async (request) => {
        calls.push(request);
        return {
          platform: 'telegram',
          channelId: 'tg-1',
          threadId: request.threadId,
          messageId: 'msg-1',
          fileName: request.name ?? 'report.txt',
        };
      },
    });

    const result = await handleSendMessagingFile(ctx, {
      path: 'out/report.txt',
      name: 'daily.txt',
      caption: 'Daily report',
      platform: 'telegram',
      channelId: 'tg-1',
      threadId: 42,
    });

    expect(result.isError).toBe(false);
    expect(calls).toEqual([{
      path: resolve(workingDirectory, 'out/report.txt'),
      name: 'daily.txt',
      caption: 'Daily report',
      platform: 'telegram',
      channelId: 'tg-1',
      threadId: 42,
    }]);
    expect(result.content[0]!.text).toContain('Sent daily.txt to telegram channel tg-1 topic 42');
  });
});
