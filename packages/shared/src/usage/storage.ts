import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { getWorkspaceSessionsPath } from '../workspaces/storage.ts';
import { listSessions } from '../sessions/storage.ts';
import type { SessionMetadata } from '../sessions/types.ts';
import type { UsagePriceSnapshot, UsageQuery, UsageRecordV1 } from './types.ts';

interface UsageFileCacheEntry {
  mtimeMs: number;
  size: number;
  ids: Set<string>;
  records: UsageRecordV1[];
}

// Usage reports may need historical rows to reconcile pre-ledger session
// metadata. Cache parsed month files and validate them by mtime+size so repeat
// reports do not synchronously reparse the entire ledger on the server loop.
const usageFileCache = new Map<string, UsageFileCacheEntry>();
const MAX_CACHED_USAGE_FILES = 128;

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
    ...(record.usageScope === 'tool' ? { usageScope: 'tool' as const } : {}),
    ...(priceSnapshot ? { priceSnapshot } : {}),
    ...(record.contextWindow ? { contextWindow: normalizeNumber(record.contextWindow) } : {}),
    ...(record.legacyEstimate ? { legacyEstimate: true } : {}),
  };
}

function cacheUsageFile(filePath: string, entry: UsageFileCacheEntry): UsageFileCacheEntry {
  usageFileCache.delete(filePath);
  usageFileCache.set(filePath, entry);
  while (usageFileCache.size > MAX_CACHED_USAGE_FILES) {
    const oldest = usageFileCache.keys().next().value as string | undefined;
    if (!oldest) break;
    usageFileCache.delete(oldest);
  }
  return entry;
}

function readUsageFile(filePath: string): UsageFileCacheEntry {
  if (!existsSync(filePath)) {
    usageFileCache.delete(filePath);
    return { mtimeMs: 0, size: 0, ids: new Set(), records: [] };
  }

  const stat = statSync(filePath);
  const cached = usageFileCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cacheUsageFile(filePath, cached);
  }

  const ids = new Set<string>();
  const records: UsageRecordV1[] = [];
  const content = readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { id?: unknown };
      if (typeof parsed.id === 'string') ids.add(parsed.id);
    } catch {
      // Ignore corrupt historical lines; valid lines still count.
    }
    const record = parseUsageLine(line);
    if (record) records.push(record);
  }
  return cacheUsageFile(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    ids,
    records,
  });
}

function readExistingIds(filePath: string): Set<string> {
  return new Set(readUsageFile(filePath).ids);
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
    const appendedRecords: UsageRecordV1[] = [];
    const lines: string[] = [];
    for (const record of fileRecords) {
      if (existingIds.has(record.id)) continue;
      existingIds.add(record.id);
      lines.push(JSON.stringify(record));
      appendedRecords.push(record);
    }
    if (lines.length > 0) {
      appendFileSync(filePath, lines.join('\n') + '\n');
      appended += lines.length;
      const stat = statSync(filePath);
      const priorRecords = usageFileCache.get(filePath)?.records ?? [];
      cacheUsageFile(filePath, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        ids: existingIds,
        records: [...priorRecords, ...appendedRecords],
      });
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
    for (const record of readUsageFile(join(dir, file)).records) {
      if (typeof query.from === 'number' && record.timestamp < query.from) continue;
      if (typeof query.to === 'number' && record.timestamp >= query.to) continue;
      records.push(record);
    }
  }

  return records.sort((a, b) => a.timestamp - b.timestamp);
}

function legacyRecordFromSession(
  session: SessionMetadata,
  ledgerRecords: readonly UsageRecordV1[] = [],
): UsageRecordV1 | null {
  const usage = session.tokenUsage;
  if (!usage || usage.totalTokens <= 0) return null;
  // Session metadata predates the append-only ledger. Its input/cache figures
  // represent the latest context, while output and cost are cumulative. Build a
  // residual baseline instead of dropping the whole legacy estimate as soon as
  // the first ledger row appears.
  const turnRecords = ledgerRecords.filter(record => record.usageScope !== 'tool');
  const latestTimestamp = turnRecords.reduce((latest, record) => Math.max(latest, record.timestamp), 0);
  const latestTurnRecords = latestTimestamp > 0
    ? turnRecords.filter(record => record.timestamp === latestTimestamp)
    : [];
  const sum = (records: readonly UsageRecordV1[], field: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'): number =>
    records.reduce((total, record) => total + record[field], 0);
  const inputTokens = Math.max(0, usage.inputTokens - sum(latestTurnRecords, 'inputTokens'));
  const outputTokens = Math.max(0, usage.outputTokens - sum(turnRecords, 'outputTokens'));
  const cacheReadTokens = Math.max(0, (usage.cacheReadTokens ?? 0) - sum(latestTurnRecords, 'cacheReadTokens'));
  const cacheCreationTokens = Math.max(0, (usage.cacheCreationTokens ?? 0) - sum(latestTurnRecords, 'cacheCreationTokens'));
  const totalTokens = inputTokens + outputTokens;
  // Session metadata only accumulates provider/SDK-reported cost. Locally
  // estimated ledger cost is additive and was never folded into that legacy
  // cumulative field, so subtracting it here would erase the estimate.
  const ledgerCost = turnRecords.reduce(
    (total, record) => total + (
      record.costSource === 'sdk' || record.costSource === 'legacy'
        ? (record.costUsd ?? 0)
        : 0
    ),
    0,
  );
  const costUsd = Math.max(0, usage.costUsd - ledgerCost);
  if (ledgerRecords.length > 0 && totalTokens === 0 && costUsd === 0) return null;
  const timestamp = session.lastMessageAt ?? session.lastUsedAt ?? session.createdAt;
  return {
    version: 1,
    id: `legacy:${session.id}`,
    timestamp,
    sessionId: session.id,
    ...(session.projectId ? { projectId: session.projectId } : {}),
    ...(session.llmConnection ? { llmConnection: session.llmConnection } : {}),
    model: session.model ?? 'unknown',
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    costUsd,
    costSource: 'legacy',
    ...(usage.contextWindow ? { contextWindow: usage.contextWindow } : {}),
    legacyEstimate: true,
  };
}

export function readLegacyUsageEstimates(
  workspaceRootPath: string,
  ledgerRecords: readonly UsageRecordV1[],
  query: UsageQuery = {},
): UsageRecordV1[] {
  const sessionsDir = getWorkspaceSessionsPath(workspaceRootPath);
  if (!existsSync(sessionsDir)) return [];

  const ledgerBySession = new Map<string, UsageRecordV1[]>();
  for (const record of ledgerRecords) {
    const records = ledgerBySession.get(record.sessionId) ?? [];
    records.push(record);
    ledgerBySession.set(record.sessionId, records);
  }

  const records: UsageRecordV1[] = [];
  for (const session of listSessions(workspaceRootPath)) {
    const record = legacyRecordFromSession(session, ledgerBySession.get(session.id) ?? []);
    if (!record) continue;
    if (typeof query.from === 'number' && record.timestamp < query.from) continue;
    if (typeof query.to === 'number' && record.timestamp >= query.to) continue;
    records.push(record);
  }
  return records;
}
