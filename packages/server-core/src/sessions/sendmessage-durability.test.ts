import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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

    let ackedMessageId: string | null = null
    let onDiskAtAck = false

    await sm.sendMessage(
      sessionId,
      'queued message',
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

  it('tracks a steered mid-stream message as the fallback retry target', async () => {
    const sessionId = 'durability-steered-fallback'
    const managed = buildSession(sessionId)
    managed.isProcessing = true
    managed.messages.push(
      { id: 'prev-user', role: 'user', content: 'previous message', timestamp: 1 } as never,
      { id: 'prev-tool', role: 'tool', content: 'side effect already happened', timestamp: 2 } as never,
    )
    managed.modelFallbackState = {
      attemptedKeys: new Set<string>(),
      userMessageId: 'prev-user',
      inProgress: false,
    }
    managed.lastSentMessage = 'previous message'

    const redirectedMessages: string[] = []
    managed.agent = {
      redirect(message: string) {
        redirectedMessages.push(message)
        return true
      },
    } as never

    const ackedMessageIds: string[] = []
    await sm.sendMessage(
      sessionId,
      'steered message',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (messageId) => {
        ackedMessageIds.push(messageId)
      },
    )

    expect(redirectedMessages).toEqual(['steered message'])
    expect(ackedMessageIds).toHaveLength(1)
    expect(managed.messageQueue).toHaveLength(0)
    expect(managed.lastSentMessage).toBe('steered message')
    const ackedMessageId = ackedMessageIds[0]
    expect(managed.modelFallbackState?.userMessageId).toBe(ackedMessageId)
    expect((sm as unknown as {
      hasModelOutputAfterUser: typeof SessionManager.prototype['hasModelOutputAfterUser']
    }).hasModelOutputAfterUser(managed, ackedMessageId!)).toBe(false)
  })
})
