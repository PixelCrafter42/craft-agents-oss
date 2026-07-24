import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { getSessionFilePath } from '@craft-agent/shared/sessions/storage'
import { SessionManager, createManagedSession } from './SessionManager.ts'

// Regression test for the High-severity finding in eb81086e:
//
//   sendMessage's `{ accepted, messageId }` ack contract was returning before
//   the user message hit disk because `persistSession` only enqueues with a
//   500ms debounce. A crash inside the debounce window after ack would lose
//   the message.
//
// The fix added `await this.flushSession(managed.id)` between persistSession
// and onAck. This test locks that ordering by reading the session file from
// inside the onAck callback and asserting the user message is already there.

describe('sendMessage durability', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-durability-'))
    sm = new SessionManager()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildSession(id: string) {
    const workspace = {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id, name: 'durability test' },
      workspace as never,
      { messagesLoaded: true },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  function readPersistedMessageIds(sessionId: string): string[] {
    const path = getSessionFilePath(tmpRoot, sessionId)
    if (!existsSync(path)) return []
    const lines = readFileSync(path, 'utf-8').trim().split('\n')
    // First line is the header, remaining lines are messages.
    return lines.slice(1).map(l => JSON.parse(l)).map(m => m.id as string)
  }

  it('user message is on disk before onAck fires (normal branch)', async () => {
    const sessionId = 'durability-normal'
    buildSession(sessionId)

    let ackedMessageId: string | null = null
    let onDiskAtAck = false

    // sendMessage continues past the ack into agent-init, which reports an
    // error event because this minimal harness does not call setSessionPlatform().
    // We only care about the persist+flush+ack ordering before agent-init.
    await sm
      .sendMessage(
        sessionId,
        'hello',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        (messageId) => {
          ackedMessageId = messageId
          onDiskAtAck = readPersistedMessageIds(sessionId).includes(messageId)
        },
      )

    expect(ackedMessageId).not.toBeNull()
    expect(onDiskAtAck).toBe(true)
  })

  it('user message is on disk before onAck fires (mid-stream / queued branch)', async () => {
    const sessionId = 'durability-midstream'
    const managed = buildSession(sessionId)
    // Force the mid-stream branch. Agent is null, so redirect() falls back to
    // false and the queue path runs.
    managed.isProcessing = true
    managed.activeMessagingOriginId = 'origin-active'

    let ackedMessageId: string | null = null
    let onDiskAtAck = false

    await sm.sendMessage(
      sessionId,
      'queued message',
      undefined,
      undefined,
      { messagingOriginId: 'origin-queued' },
      undefined,
      undefined,
      (messageId) => {
        ackedMessageId = messageId
        onDiskAtAck = readPersistedMessageIds(sessionId).includes(messageId)
      },
    )

    expect(ackedMessageId).not.toBeNull()
    expect(onDiskAtAck).toBe(true)
    expect(managed.activeMessagingOriginId).toBe('origin-active')
    expect(managed.messageQueue[0]?.options?.messagingOriginId).toBe('origin-queued')
  })

  it('tracks a steered mid-stream message as the fallback retry target', async () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'sm-durability-config-'))
    const sessionManagerModule = pathToFileURL(join(import.meta.dir, 'SessionManager.ts')).href
    try {
      mkdirSync(configRoot, { recursive: true })
      writeFileSync(join(configRoot, 'config.json'), JSON.stringify({
        activeSessionId: null,
        defaultLlmConnection: 'steer-test',
        llmConnections: [{
          slug: 'steer-test',
          name: 'Steer Test',
          providerType: 'pi',
          authType: 'api_key',
          createdAt: Date.now(),
          midStreamBehavior: 'steer',
        }],
      }, null, 2), 'utf-8')

      const probe = Bun.spawnSync([
        process.execPath,
        '--eval',
        `
          const { SessionManager, createManagedSession } = await import(${JSON.stringify(sessionManagerModule)});
          const sessionId = 'durability-steered-fallback';
          const tmpRoot = process.env.TEST_WORKSPACE_ROOT;
          const sm = new SessionManager();
          const workspace = {
            id: 'ws_test',
            name: 'Test Workspace',
            rootPath: tmpRoot,
            createdAt: Date.now(),
          };
          const managed = createManagedSession(
            { id: sessionId, name: 'durability test', llmConnection: 'steer-test' },
            workspace,
            { messagesLoaded: true },
          );
          sm.sessions.set(sessionId, managed);
          managed.isProcessing = true;
          managed.activeMessagingOriginId = 'origin-active';
          managed.messages.push(
            { id: 'prev-user', role: 'user', content: 'previous message', timestamp: 1 },
            { id: 'prev-tool', role: 'tool', content: 'side effect already happened', timestamp: 2 },
          );
          managed.modelFallbackState = {
            attemptedKeys: new Set(),
            userMessageId: 'prev-user',
            inProgress: false,
          };
          managed.lastSentMessage = 'previous message';

          const redirectedMessages = [];
          managed.agent = {
            redirect(message) {
              redirectedMessages.push(message);
              return true;
            },
          };

          const ackedMessageIds = [];
          await sm.sendMessage(
            sessionId,
            'steered message',
            undefined,
            undefined,
            { messagingOriginId: 'origin-steer' },
            undefined,
            undefined,
            (messageId) => {
              ackedMessageIds.push(messageId);
            },
          );

          const ackedMessageId = ackedMessageIds[0];
          console.log(JSON.stringify({
            redirectedMessages,
            ackedMessageCount: ackedMessageIds.length,
            messageQueueLength: managed.messageQueue.length,
            lastSentMessage: managed.lastSentMessage,
            activeMessagingOriginId: managed.activeMessagingOriginId,
            lastSentMessagingOriginId: managed.lastSentOptions?.messagingOriginId,
            fallbackUserMessageId: managed.modelFallbackState?.userMessageId,
            hasModelOutputAfterUser: sm.hasModelOutputAfterUser(managed, ackedMessageId),
            ackedMessageId,
          }));
        `,
      ], {
        env: {
          ...process.env,
          CRAFT_CONFIG_DIR: configRoot,
          TEST_WORKSPACE_ROOT: tmpRoot,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })

      if (probe.exitCode !== 0) {
        throw new Error(`steer probe failed:\n${probe.stderr.toString()}`)
      }
      const result = JSON.parse(probe.stdout.toString().trim().split('\n').at(-1) ?? '{}')

      expect(result.redirectedMessages).toEqual(['steered message'])
      expect(result.ackedMessageCount).toBe(1)
      expect(result.messageQueueLength).toBe(0)
      expect(result.lastSentMessage).toBe('steered message')
      expect(result.activeMessagingOriginId).toBe('origin-active')
      expect(result.lastSentMessagingOriginId).toBe('origin-active')
      expect(result.fallbackUserMessageId).toBe(result.ackedMessageId)
      expect(result.hasModelOutputAfterUser).toBe(false)
    } finally {
      rmSync(configRoot, { recursive: true, force: true })
    }
  })
})
