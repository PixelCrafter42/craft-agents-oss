import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readUsageRecords } from '@craft-agent/shared/usage'
import { SessionManager, createManagedSession } from './SessionManager.ts'

describe('external tool usage ledger', () => {
  let root: string
  let manager: SessionManager

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'external-usage-'))
    manager = new SessionManager()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('writes a tool-scoped record without changing session turn totals', async () => {
    const workspace = { id: 'ws', name: 'Workspace', rootPath: root, createdAt: Date.now() }
    const managed = createManagedSession(
      {
        id: 'session-1',
        projectId: 'project-1',
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          contextTokens: 0,
          costUsd: 0.01,
        },
      },
      workspace as never,
      { messagesLoaded: true },
    )
    const before = structuredClone(managed.tokenUsage)

    await (manager as unknown as {
      processEvent: (session: typeof managed, event: unknown) => Promise<void>
    }).processEvent(managed, {
      type: 'external_usage',
      provider: 'xai',
      model: 'grok-imagine-image-quality',
      usage: {
        usageId: 'image-1',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0.05,
      },
    })

    expect(managed.tokenUsage).toEqual(before)
    expect(readUsageRecords(root)).toEqual([
      expect.objectContaining({
        id: 'usage:session-1:image-1:grok-imagine-image-quality:0',
        sessionId: 'session-1',
        projectId: 'project-1',
        provider: 'xai',
        model: 'grok-imagine-image-quality',
        usageScope: 'tool',
        totalTokens: 0,
        costUsd: 0.05,
        costSource: 'sdk',
      }),
    ])
  })
})
