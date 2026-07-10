import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  appendUsageRecords,
  readLegacyUsageEstimates,
  readUsageRecords,
  type UsageRecordV1,
} from '@craft-agent/shared/usage'
import { SessionManager, createManagedSession } from './SessionManager.ts'

describe('usage ledger migration baseline', () => {
  let root: string
  let manager: SessionManager

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'usage-ledger-migration-'))
    manager = new SessionManager()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function managedSession() {
    return createManagedSession({
      id: 'session-1',
      model: 'grok-4.5',
      projectId: 'project-1',
      lastMessageAt: 123,
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        contextTokens: 0,
        costUsd: 0.10,
        cacheReadTokens: 20,
        cacheCreationTokens: 5,
      },
    }, {
      id: 'ws',
      name: 'Workspace',
      rootPath: root,
      createdAt: 1,
    } as never, { messagesLoaded: true })
  }

  function captureBaseline(managed: ReturnType<typeof managedSession>): void {
    ;(manager as unknown as {
      ensureLegacyUsageBaseline: (session: typeof managed) => void
    }).ensureLegacyUsageBaseline(managed)
  }

  function ledgerRecord(overrides: Partial<UsageRecordV1>): UsageRecordV1 {
    return {
      version: 1,
      id: 'record',
      timestamp: 200,
      sessionId: 'session-1',
      model: 'grok-4.5',
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 12,
      costUsd: 0.01,
      costSource: 'sdk',
      ...overrides,
    }
  }

  it('captures old cumulative usage even when a tool-only row already exists', () => {
    appendUsageRecords(root, [ledgerRecord({ id: 'tool', usageScope: 'tool' })])
    const managed = managedSession()

    captureBaseline(managed)
    captureBaseline(managed)

    expect(readUsageRecords(root)).toEqual([
      expect.objectContaining({
        id: 'usage:session-1:legacy-baseline:v1',
        timestamp: 123,
        sessionId: 'session-1',
        projectId: 'project-1',
        model: 'grok-4.5',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 20,
        cacheCreationTokens: 5,
        totalTokens: 150,
        costUsd: 0.10,
        costSource: 'legacy',
        legacyEstimate: true,
      }),
      expect.objectContaining({ id: 'tool', usageScope: 'tool' }),
    ])
  })

  it('does not backfill a baseline after a turn ledger already exists', () => {
    appendUsageRecords(root, [ledgerRecord({ id: 'existing-turn' })])

    captureBaseline(managedSession())

    expect(readUsageRecords(root).map(record => record.id)).toEqual(['existing-turn'])
  })

  it('makes the first new turn additive without a synthetic residual', async () => {
    const managed = managedSession()
    captureBaseline(managed)

    await (manager as unknown as {
      processEvent: (session: typeof managed, event: unknown) => Promise<void>
    }).processEvent(managed, {
      type: 'complete',
      usage: {
        usageId: 'new-turn',
        inputTokens: 200,
        outputTokens: 10,
        totalTokens: 210,
        costUsd: 0.02,
      },
    })

    const sessionDir = join(root, 'sessions', managed.id)
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'session.jsonl'), JSON.stringify({
      id: managed.id,
      workspaceRootPath: root,
      createdAt: 1,
      lastUsedAt: 200,
      lastMessageAt: 200,
      messageCount: 2,
      model: managed.model,
      projectId: managed.projectId,
      tokenUsage: managed.tokenUsage,
    }) + '\n')

    const ledger = readUsageRecords(root)
    expect(ledger.map(record => record.id)).toEqual([
      'usage:session-1:legacy-baseline:v1',
      'usage:session-1:new-turn:grok-4.5:0',
    ])
    expect(ledger.reduce((sum, record) => sum + record.outputTokens, 0)).toBe(60)
    expect(ledger.reduce((sum, record) => sum + (record.costUsd ?? 0), 0)).toBeCloseTo(0.12, 10)
    expect(readLegacyUsageEstimates(root, ledger, { from: 0, to: Date.now() + 1 })).toEqual([])
  })
})
