import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AUTOMATIONS_SESSION_STATE_FILE } from '@craft-agent/shared/automations'
import { SessionManager } from './SessionManager.ts'

// Regression test for craft-agents-oss#943:
//
//   The automation "Test" action awaited executePromptAutomation → sendMessage
//   to *full* completion. A prompt that used tools or produced >30s of output
//   tripped the 30s RPC client timeout and reported failure even though the
//   session streamed fine.
//
// The fix adds `waitForCompletion` to ExecutePromptAutomationInput. The Test
// handler passes `false` so the method returns once the session is created and
// the prompt is dispatched (fire-and-forget, error-logged). Real automation
// execution omits the flag and keeps awaiting completion.
//
// These tests stub the heavy collaborators (createSession / sendEvent /
// sendMessage) and lock the branch: waitForCompletion:false resolves even when
// sendMessage never settles; the default still awaits (and propagates errors).

describe('executePromptAutomation waitForCompletion', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'exec-prompt-automation-'))
    sm = new SessionManager()
    // Stub the collaborators executePromptAutomation touches. With no labels /
    // mentions / llmConnection in the input, everything else is skipped.
    ;(sm as unknown as { createSession: unknown }).createSession = async () => ({ id: 'test-sess' })
    ;(sm as unknown as { sendEvent: unknown }).sendEvent = () => {}
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('waitForCompletion:false returns as soon as the session is created (does not await the turn)', async () => {
    let sendCalled = false
    // Never-resolving send simulates a long tool-using turn.
    ;(sm as unknown as { sendMessage: unknown }).sendMessage = () => {
      sendCalled = true
      return new Promise<never>(() => {})
    }

    const result = await sm.executePromptAutomation({
      workspaceId: 'ws_test',
      workspaceRootPath: tmpRoot,
      prompt: 'do something long',
      waitForCompletion: false,
    })

    expect(result.sessionId).toBe('test-sess')
    expect(sendCalled).toBe(true)
  })

  it('default (waitForCompletion unset) awaits sendMessage and propagates its error', async () => {
    ;(sm as unknown as { sendMessage: unknown }).sendMessage = () =>
      Promise.reject(new Error('send failed'))

    await expect(
      sm.executePromptAutomation({
        workspaceId: 'ws_test',
        workspaceRootPath: tmpRoot,
        prompt: 'do something',
      }),
    ).rejects.toThrow('send failed')
  })
})

describe('executePromptAutomation session reuse', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'exec-prompt-automation-reuse-'))
    sm = new SessionManager()
    ;(sm as unknown as { sendEvent: unknown }).sendEvent = () => {}
    ;(sm as unknown as { persistSession: unknown }).persistSession = () => {}
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function installStubs() {
    let next = 0
    const created: string[] = []
    const sent: Array<{ sessionId: string; message: string }> = []
    const sessions = (sm as unknown as { sessions: Map<string, unknown> }).sessions

    ;(sm as unknown as { createSession: unknown }).createSession = async () => {
      const id = `sess-${++next}`
      created.push(id)
      sessions.set(id, {
        id,
        workspace: { id: 'ws_test', rootPath: tmpRoot },
      })
      return { id }
    }
    ;(sm as unknown as { sendMessage: unknown }).sendMessage = async (sessionId: string, message: string) => {
      sent.push({ sessionId, message })
    }

    return { created, sent, sessions }
  }

  function readState(): { sessions?: Record<string, { sessionId: string }> } {
    return JSON.parse(readFileSync(join(tmpRoot, AUTOMATIONS_SESSION_STATE_FILE), 'utf-8'))
  }

  it('keeps the default behavior: each trigger creates a new session', async () => {
    const { created, sent } = installStubs()

    await sm.executePromptAutomation({
      workspaceId: 'ws_test',
      workspaceRootPath: tmpRoot,
      prompt: 'first',
    })
    await sm.executePromptAutomation({
      workspaceId: 'ws_test',
      workspaceRootPath: tmpRoot,
      prompt: 'second',
    })

    expect(created).toEqual(['sess-1', 'sess-2'])
    expect(sent.map(s => s.sessionId)).toEqual(['sess-1', 'sess-2'])
    expect(existsSync(join(tmpRoot, AUTOMATIONS_SESSION_STATE_FILE))).toBe(false)
  })

  it('reuseSession creates once and reuses the same session on later triggers', async () => {
    const { created, sent } = installStubs()

    await sm.executePromptAutomation({
      workspaceId: 'ws_test',
      workspaceRootPath: tmpRoot,
      matcherId: 'auto1',
      reuseSession: true,
      prompt: 'first',
    })
    await sm.executePromptAutomation({
      workspaceId: 'ws_test',
      workspaceRootPath: tmpRoot,
      matcherId: 'auto1',
      reuseSession: true,
      prompt: 'second',
    })

    expect(created).toEqual(['sess-1'])
    expect(sent).toEqual([
      { sessionId: 'sess-1', message: 'first' },
      { sessionId: 'sess-1', message: 'second' },
    ])
    expect(readState().sessions?.auto1?.sessionId).toBe('sess-1')
  })

  it('recreates and updates state when the stored reuse session is gone', async () => {
    const { created, sent } = installStubs()
    writeFileSync(join(tmpRoot, AUTOMATIONS_SESSION_STATE_FILE), JSON.stringify({
      version: 1,
      sessions: { auto1: { sessionId: 'deleted-session', updatedAt: Date.now() } },
    }), 'utf-8')

    await sm.executePromptAutomation({
      workspaceId: 'ws_test',
      workspaceRootPath: tmpRoot,
      matcherId: 'auto1',
      reuseSession: true,
      prompt: 'after delete',
    })

    expect(created).toEqual(['sess-1'])
    expect(sent.map(s => s.sessionId)).toEqual(['sess-1'])
    expect(readState().sessions?.auto1?.sessionId).toBe('sess-1')
  })

  it('uses an explicit targetSessionId without creating a new session', async () => {
    const { created, sent, sessions } = installStubs()
    sessions.set('existing-session', {
      id: 'existing-session',
      workspace: { id: 'ws_test', rootPath: tmpRoot },
    })

    await sm.executePromptAutomation({
      workspaceId: 'ws_test',
      workspaceRootPath: tmpRoot,
      matcherId: 'auto1',
      reuseSession: true,
      targetSessionId: 'existing-session',
      prompt: 'explicit target',
    })

    expect(created).toEqual([])
    expect(sent).toEqual([{ sessionId: 'existing-session', message: 'explicit target' }])
    expect(existsSync(join(tmpRoot, AUTOMATIONS_SESSION_STATE_FILE))).toBe(false)
  })

  it('serializes concurrent prompts sent to the same explicit target session', async () => {
    const { created, sent, sessions } = installStubs()
    sessions.set('existing-session', {
      id: 'existing-session',
      workspace: { id: 'ws_test', rootPath: tmpRoot },
    })

    let releaseFirst!: () => void
    const firstTurn = new Promise<void>((resolve) => { releaseFirst = resolve })
    let calls = 0
    ;(sm as unknown as { sendMessage: unknown }).sendMessage = async (sessionId: string, message: string) => {
      sent.push({ sessionId, message })
      calls += 1
      if (calls === 1) await firstTurn
    }

    const first = sm.executePromptAutomation({
      workspaceId: 'ws_test',
      workspaceRootPath: tmpRoot,
      targetSessionId: 'existing-session',
      prompt: 'first',
    })
    await Promise.resolve()
    await Promise.resolve()

    const second = sm.executePromptAutomation({
      workspaceId: 'ws_test',
      workspaceRootPath: tmpRoot,
      targetSessionId: 'existing-session',
      prompt: 'second',
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(created).toEqual([])
    expect(sent).toEqual([{ sessionId: 'existing-session', message: 'first' }])

    releaseFirst()
    await Promise.all([first, second])
    expect(sent).toEqual([
      { sessionId: 'existing-session', message: 'first' },
      { sessionId: 'existing-session', message: 'second' },
    ])
  })

  it('test-mode reuseSession does not read or write production reuse state', async () => {
    const { created, sent } = installStubs()

    await sm.executePromptAutomation({
      workspaceId: 'ws_test',
      workspaceRootPath: tmpRoot,
      matcherId: 'auto1',
      reuseSession: true,
      prompt: 'test first',
      waitForCompletion: false,
      persistReuseState: false,
    })
    await sm.executePromptAutomation({
      workspaceId: 'ws_test',
      workspaceRootPath: tmpRoot,
      matcherId: 'auto1',
      reuseSession: true,
      prompt: 'test second',
      waitForCompletion: false,
      persistReuseState: false,
    })

    expect(created).toEqual(['sess-1', 'sess-2'])
    expect(sent.map(s => s.sessionId)).toEqual(['sess-1', 'sess-2'])
    expect(existsSync(join(tmpRoot, AUTOMATIONS_SESSION_STATE_FILE))).toBe(false)
  })
})
