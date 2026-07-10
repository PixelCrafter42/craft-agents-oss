import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  aggregateUsageRecords,
  appendUsageRecords,
  estimateUsageCost,
  getUsageFilePath,
  readLegacyUsageEstimates,
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

  it('invalidates a cached month when another writer changes the file', () => {
    const first = record({ id: 'first' });
    appendUsageRecords(workspace, [first]);
    expect(readUsageRecords(workspace).map(item => item.id)).toEqual(['first']);

    const second = record({ id: 'second', timestamp: first.timestamp + 1 });
    appendFileSync(getUsageFilePath(workspace, second.timestamp), `${JSON.stringify(second)}\n`);

    expect(readUsageRecords(workspace).map(item => item.id)).toEqual(['first', 'second']);
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

  it('keeps only the pre-ledger residual from cumulative legacy session usage', () => {
    const sessionDir = join(workspace, 'sessions', 's1');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.jsonl'), JSON.stringify({
      id: 's1',
      workspaceRootPath: workspace,
      createdAt: 1,
      lastUsedAt: 200,
      lastMessageAt: 200,
      messageCount: 2,
      model: 'grok-4.5',
      tokenUsage: {
        inputTokens: 120,
        outputTokens: 70,
        totalTokens: 190,
        contextTokens: 0,
        costUsd: 0.07,
        cacheReadTokens: 10,
        cacheCreationTokens: 4,
      },
    }) + '\n');

    const turn = record({
      id: 'turn-1',
      timestamp: 200,
      inputTokens: 120,
      outputTokens: 20,
      totalTokens: 140,
      cacheReadTokens: 10,
      cacheCreationTokens: 4,
      costUsd: 0.02,
    });
    const tool = record({
      id: 'tool-1',
      timestamp: 199,
      inputTokens: 5,
      outputTokens: 5,
      totalTokens: 10,
      costUsd: 0.005,
      usageScope: 'tool',
    });

    const legacy = readLegacyUsageEstimates(workspace, [turn, tool], { from: 0, to: 1_000 });
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatchObject({
      sessionId: 's1',
      inputTokens: 0,
      outputTokens: 50,
      totalTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.05,
      legacyEstimate: true,
    });
  });

  it('does not subtract locally estimated ledger cost from SDK-only session totals', () => {
    const sessionDir = join(workspace, 'sessions', 's1');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.jsonl'), JSON.stringify({
      id: 's1',
      workspaceRootPath: workspace,
      createdAt: 1,
      lastUsedAt: 200,
      lastMessageAt: 200,
      messageCount: 2,
      model: 'grok-4.5',
      tokenUsage: {
        inputTokens: 200,
        outputTokens: 60,
        totalTokens: 260,
        contextTokens: 0,
        costUsd: 0.10,
      },
    }) + '\n');

    const estimatedTurn = record({
      id: 'estimated-turn',
      timestamp: 200,
      inputTokens: 200,
      outputTokens: 10,
      totalTokens: 210,
      costUsd: 0.02,
      costSource: 'estimated',
    });

    const legacy = readLegacyUsageEstimates(workspace, [estimatedTurn], { from: 0, to: 1_000 });
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 50,
      totalTokens: 50,
      costUsd: 0.10,
    });

    const report = aggregateUsageRecords([estimatedTurn, ...legacy], {
      from: 0,
      to: 1_000,
      timezone: 'UTC',
    });
    expect(report.totals.costUsd).toBeCloseTo(0.12, 10);
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
