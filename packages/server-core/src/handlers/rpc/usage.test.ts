import { describe, expect, it } from 'bun:test'
import type { UsageRecordV1 } from '@craft-agent/shared/usage'
import { filterUsageLedgerRecords } from './usage.ts'

function record(overrides: Partial<UsageRecordV1> = {}): UsageRecordV1 {
  return {
    version: 1,
    id: 'turn',
    timestamp: 100,
    sessionId: 'session-1',
    model: 'model',
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

describe('usage report ledger filtering', () => {
  it('excludes persisted migration baselines when includeLegacy is false', () => {
    const baseline = record({
      id: 'baseline',
      timestamp: 90,
      costSource: 'legacy',
      legacyEstimate: true,
    })
    const current = record({ id: 'current', timestamp: 100 })

    expect(filterUsageLedgerRecords([baseline, current], 0, 200, false)).toEqual([current])
    expect(filterUsageLedgerRecords([baseline, current], 0, 200, true)).toEqual([baseline, current])
  })

  it('still applies the half-open report window', () => {
    expect(filterUsageLedgerRecords([
      record({ id: 'before', timestamp: 9 }),
      record({ id: 'inside', timestamp: 10 }),
      record({ id: 'end', timestamp: 20 }),
    ], 10, 20, true).map(item => item.id)).toEqual(['inside'])
  })
})
