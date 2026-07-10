import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  aggregateUsageRecords,
  appendUsageRecords,
  estimateUsageCost,
  getUsageFilePath,
  readUsageRecords,
} from '../index.ts';
import type { UsageRecordV1 } from '../types.ts';

function tmpWorkspace(): string {
  const dir = join(tmpdir(), `usage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function record(overrides: Partial<UsageRecordV1> = {}): UsageRecordV1 {
  return {
    version: 1,
    id: 'u1',
    timestamp: Date.UTC(2026, 0, 31, 23, 30),
    sessionId: 's1',
    llmConnection: 'anthropic',
    provider: 'anthropic',
    model: 'claude-sonnet',
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 10,
    cacheCreationTokens: 5,
    totalTokens: 120,
    costUsd: 0.01,
    costSource: 'sdk',
    contextWindow: 200000,
    ...overrides,
  };
}

describe('usage ledger storage', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = tmpWorkspace();
  });

  afterEach(() => {
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });
  });

  it('writes usage records to UTC month files and deduplicates by id', () => {
    const usage = record();

    expect(appendUsageRecords(workspace, [usage, usage])).toBe(1);

    const file = getUsageFilePath(workspace, usage.timestamp);
    expect(file.endsWith(join('usage', '2026-01.jsonl'))).toBe(true);
    const lines = readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);

    expect(appendUsageRecords(workspace, [usage])).toBe(0);
    expect(readUsageRecords(workspace)).toHaveLength(1);
  });

  it('keeps unknown prices as unknown instead of fabricating cost', () => {
    appendUsageRecords(workspace, [record({ id: 'unknown', costUsd: null, costSource: 'unknown' })]);

    const report = aggregateUsageRecords(readUsageRecords(workspace), {
      from: 0,
      to: Date.UTC(2026, 1, 1),
      timezone: 'UTC',
    });

    expect(report.totals.totalTokens).toBe(120);
    expect(report.totals.costUsd).toBe(0);
    expect(report.totals.unknownCostCount).toBe(1);
  });

  it('estimates cost from the local model price table when available', () => {
    const estimate = estimateUsageCost({
      provider: 'pi',
      model: 'pi/grok-build',
      inputTokens: 110,
      outputTokens: 25,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
    });

    expect(estimate).not.toBeNull();
    expect(estimate!.priceSnapshot.source).toBe('local:xai-provider-extension');
    expect(estimate!.costUsd).toBeCloseTo(0.000148, 9);
  });
});

describe('usage aggregation', () => {
  it('groups days using the requested timezone', () => {
    const records = [
      record({ id: 'utc-late', timestamp: Date.UTC(2026, 0, 31, 23, 30) }),
    ];

    const utc = aggregateUsageRecords(records, {
      from: Date.UTC(2026, 0, 31),
      to: Date.UTC(2026, 1, 2),
      timezone: 'UTC',
    });
    const shanghai = aggregateUsageRecords(records, {
      from: Date.UTC(2026, 0, 31),
      to: Date.UTC(2026, 1, 2),
      timezone: 'Asia/Shanghai',
    });

    expect(utc.byDay[0]?.date).toBe('2026-01-31');
    expect(shanghai.byDay[0]?.date).toBe('2026-02-01');
  });

  it('marks sessions missing from current storage as deleted', () => {
    const report = aggregateUsageRecords([record({ sessionId: 'deleted-session' })], {
      from: 0,
      to: Date.UTC(2026, 1, 1),
      timezone: 'UTC',
      existingSessionIds: new Set(['active-session']),
    });

    expect(report.bySession[0]?.label).toBe('Deleted session');
    expect(report.bySession[0]?.sessionDeleted).toBe(true);
  });
});
