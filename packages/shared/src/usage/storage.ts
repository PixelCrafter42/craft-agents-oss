import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'fs';
import { join } from 'path';
import { getWorkspaceSessionsPath } from '../workspaces/storage.ts';
import { listSessions } from '../sessions/storage.ts';
import type { SessionMetadata } from '../sessions/types.ts';
import type { UsagePriceSnapshot, UsageQuery, UsageRecordV1 } from './types.ts';

export function getWorkspaceUsagePath(workspaceRootPath: string): string {
  return join(workspaceRootPath, 'usage');
}

export function ensureWorkspaceUsageDir(workspaceRootPath: string): string {
  const dir = getWorkspaceUsagePath(workspaceRootPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function getUsageMonthKey(timestamp: number): string {
  const d = new Date(timestamp);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export function getUsageFilePath(workspaceRootPath: string, timestamp: number): string {
  return join(getWorkspaceUsagePath(workspaceRootPath), `${getUsageMonthKey(timestamp)}.jsonl`);
}

function normalizeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function normalizePrice(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizePriceSnapshot(snapshot: unknown): UsagePriceSnapshot | undefined {
  if (!snapshot || typeof snapshot !== 'object') return undefined;
  const candidate = snapshot as Partial<UsagePriceSnapshot>;
  const inputUsdPerMillion = normalizePrice(candidate.inputUsdPerMillion);
  const outputUsdPerMillion = normalizePrice(candidate.outputUsdPerMillion);
  if (inputUsdPerMillion === undefined || outputUsdPerMillion === undefined || typeof candidate.source !== 'string') {
    return undefined;
  }
  const cacheReadUsdPerMillion = normalizePrice(candidate.cacheReadUsdPerMillion);
  const cacheCreationUsdPerMillion = normalizePrice(candidate.cacheCreationUsdPerMillion);
  return {
    inputUsdPerMillion,
    outputUsdPerMillion,
    ...(cacheReadUsdPerMillion !== undefined ? { cacheReadUsdPerMillion } : {}),
    ...(cacheCreationUsdPerMillion !== undefined ? { cacheCreationUsdPerMillion } : {}),
    source: candidate.source,
  };
}

function normalizeRecord(record: UsageRecordV1): UsageRecordV1 {
  const inputTokens = normalizeNumber(record.inputTokens);
  const outputTokens = normalizeNumber(record.outputTokens);
  const cacheReadTokens = normalizeNumber(record.cacheReadTokens);
  const cacheCreationTokens = normalizeNumber(record.cacheCreationTokens);
  const totalTokens = normalizeNumber(record.totalTokens) || inputTokens + outputTokens;
  const priceSnapshot = normalizePriceSnapshot(record.priceSnapshot);

  return {
    version: 1,
    id: record.id,
    timestamp: normalizeNumber(record.timestamp),
    sessionId: record.sessionId,
    ...(record.projectId ? { projectId: record.projectId } : {}),
    ...(record.llmConnection ? { llmConnection: record.llmConnection } : {}),
    ...(record.provider ? { provider: record.provider } : {}),
    model: record.model || 'unknown',
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    costUsd: typeof record.costUsd === 'number' && Number.isFinite(record.costUsd) ? record.costUsd : null,
    costSource: record.costSource,
    ...(priceSnapshot ? { priceSnapshot } : {}),
    ...(record.contextWindow ? { contextWindow: normalizeNumber(record.contextWindow) } : {}),
    ...(record.legacyEstimate ? { legacyEstimate: true } : {}),
  };
}

function readExistingIds(filePath: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(filePath)) return ids;
  const content = readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { id?: unknown };
      if (typeof parsed.id === 'string') ids.add(parsed.id);
    } catch {
      // Ignore corrupt historical lines; valid lines still count.
    }
  }
  return ids;
}

export function appendUsageRecords(workspaceRootPath: string, records: UsageRecordV1[]): number {
  if (records.length === 0) return 0;
  ensureWorkspaceUsageDir(workspaceRootPath);

  const grouped = new Map<string, UsageRecordV1[]>();
  for (const record of records) {
    const normalized = normalizeRecord(record);
    if (!normalized.id || !normalized.sessionId || !normalized.timestamp) continue;
    const filePath = getUsageFilePath(workspaceRootPath, normalized.timestamp);
    const list = grouped.get(filePath) ?? [];
    list.push(normalized);
    grouped.set(filePath, list);
  }

  let appended = 0;
  for (const [filePath, fileRecords] of grouped) {
    const existingIds = readExistingIds(filePath);
    const lines: string[] = [];
    for (const record of fileRecords) {
      if (existingIds.has(record.id)) continue;
      existingIds.add(record.id);
      lines.push(JSON.stringify(record));
    }
    if (lines.length > 0) {
      appendFileSync(filePath, lines.join('\n') + '\n');
      appended += lines.length;
    }
  }
  return appended;
}

function parseUsageLine(line: string): UsageRecordV1 | null {
  try {
    const parsed = JSON.parse(line) as Partial<UsageRecordV1>;
    if (parsed.version !== 1 || typeof parsed.id !== 'string' || typeof parsed.sessionId !== 'string') return null;
    if (typeof parsed.timestamp !== 'number' || typeof parsed.model !== 'string') return null;
    return normalizeRecord(parsed as UsageRecordV1);
  } catch {
    return null;
  }
}

export function readUsageRecords(workspaceRootPath: string, query: UsageQuery = {}): UsageRecordV1[] {
  const dir = getWorkspaceUsagePath(workspaceRootPath);
  if (!existsSync(dir)) return [];

  const records: UsageRecordV1[] = [];
  const files = readdirSync(dir)
    .filter(name => /^\d{4}-\d{2}\.jsonl$/.test(name))
    .sort();

  for (const file of files) {
    const content = readFileSync(join(dir, file), 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const record = parseUsageLine(line);
      if (!record) continue;
      if (typeof query.from === 'number' && record.timestamp < query.from) continue;
      if (typeof query.to === 'number' && record.timestamp >= query.to) continue;
      records.push(record);
    }
  }

  return records.sort((a, b) => a.timestamp - b.timestamp);
}

function legacyRecordFromSession(session: SessionMetadata): UsageRecordV1 | null {
  const usage = session.tokenUsage;
  if (!usage || usage.totalTokens <= 0) return null;
  const timestamp = session.lastMessageAt ?? session.lastUsedAt ?? session.createdAt;
  return {
    version: 1,
    id: `legacy:${session.id}`,
    timestamp,
    sessionId: session.id,
    ...(session.projectId ? { projectId: session.projectId } : {}),
    ...(session.llmConnection ? { llmConnection: session.llmConnection } : {}),
    model: session.model ?? 'unknown',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheCreationTokens: usage.cacheCreationTokens ?? 0,
    totalTokens: usage.totalTokens,
    costUsd: usage.costUsd,
    costSource: 'legacy',
    ...(usage.contextWindow ? { contextWindow: usage.contextWindow } : {}),
    legacyEstimate: true,
  };
}

export function readLegacyUsageEstimates(workspaceRootPath: string, ledgerSessionIds: Set<string>, query: UsageQuery = {}): UsageRecordV1[] {
  const sessionsDir = getWorkspaceSessionsPath(workspaceRootPath);
  if (!existsSync(sessionsDir)) return [];

  const records: UsageRecordV1[] = [];
  for (const session of listSessions(workspaceRootPath)) {
    if (ledgerSessionIds.has(session.id)) continue;
    const record = legacyRecordFromSession(session);
    if (!record) continue;
    if (typeof query.from === 'number' && record.timestamp < query.from) continue;
    if (typeof query.to === 'number' && record.timestamp >= query.to) continue;
    records.push(record);
  }
  return records;
}
