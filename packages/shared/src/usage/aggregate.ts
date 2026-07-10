import type { UsageDayGroup, UsageGroup, UsageRecordV1, UsageReport, UsageTotals } from './types.ts';

export interface UsageAggregationOptions {
  from: number;
  to: number;
  timezone: string;
  sessionLabels?: Map<string, string>;
  existingSessionIds?: Set<string>;
  projectLabels?: Map<string, string>;
}

export function emptyUsageTotals(): UsageTotals {
  return {
    count: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    unknownCostCount: 0,
    legacyEstimateCount: 0,
  };
}

export function addUsageToTotals(totals: UsageTotals, record: UsageRecordV1): void {
  totals.count += 1;
  totals.inputTokens += record.inputTokens;
  totals.outputTokens += record.outputTokens;
  totals.cacheReadTokens += record.cacheReadTokens;
  totals.cacheCreationTokens += record.cacheCreationTokens;
  totals.totalTokens += record.totalTokens;
  if (typeof record.costUsd === 'number' && Number.isFinite(record.costUsd)) {
    totals.costUsd += record.costUsd;
  } else {
    totals.unknownCostCount += 1;
  }
  if (record.legacyEstimate || record.costSource === 'legacy') {
    totals.legacyEstimateCount += 1;
  }
}

export function dayKeyForTimestamp(timestamp: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const year = parts.find(p => p.type === 'year')?.value ?? '1970';
  const month = parts.find(p => p.type === 'month')?.value ?? '01';
  const day = parts.find(p => p.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

function groupRecords(
  records: UsageRecordV1[],
  keyFn: (record: UsageRecordV1) => string,
  labelFn: (key: string, record: UsageRecordV1) => string,
  extra?: (key: string, record: UsageRecordV1) => Partial<Pick<UsageGroup, 'sessionDeleted'>>,
): UsageGroup[] {
  const map = new Map<string, { record: UsageRecordV1; totals: UsageTotals }>();
  for (const record of records) {
    const key = keyFn(record);
    let entry = map.get(key);
    if (!entry) {
      entry = { record, totals: emptyUsageTotals() };
      map.set(key, entry);
    }
    addUsageToTotals(entry.totals, record);
  }

  return [...map.entries()]
    .map(([key, entry]) => ({
      key,
      label: labelFn(key, entry.record),
      totals: entry.totals,
      legacyEstimate: entry.totals.legacyEstimateCount > 0,
      ...(extra?.(key, entry.record) ?? {}),
    }))
    .sort((a, b) => b.totals.costUsd - a.totals.costUsd || b.totals.totalTokens - a.totals.totalTokens || a.label.localeCompare(b.label));
}

export function aggregateUsageRecords(records: UsageRecordV1[], options: UsageAggregationOptions): UsageReport {
  const filtered = records
    .filter(record => record.timestamp >= options.from && record.timestamp < options.to)
    .sort((a, b) => a.timestamp - b.timestamp);

  const totals = emptyUsageTotals();
  for (const record of filtered) addUsageToTotals(totals, record);

  const byDayMap = new Map<string, UsageTotals>();
  for (const record of filtered) {
    const key = dayKeyForTimestamp(record.timestamp, options.timezone);
    let dayTotals = byDayMap.get(key);
    if (!dayTotals) {
      dayTotals = emptyUsageTotals();
      byDayMap.set(key, dayTotals);
    }
    addUsageToTotals(dayTotals, record);
  }

  const byDay: UsageDayGroup[] = [...byDayMap.entries()]
    .map(([date, dayTotals]) => ({ date, totals: dayTotals }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const byModel = groupRecords(
    filtered,
    record => record.model || 'unknown',
    key => key,
  );

  const byProject = groupRecords(
    filtered,
    record => record.projectId || 'unassigned',
    key => options.projectLabels?.get(key) ?? (key === 'unassigned' ? 'Unassigned' : key),
  );

  const bySession = groupRecords(
    filtered,
    record => record.sessionId || 'unknown',
    key => options.sessionLabels?.get(key) ?? (options.existingSessionIds?.has(key) ? key : 'Deleted session'),
    (key) => options.existingSessionIds ? { sessionDeleted: !options.existingSessionIds.has(key) } : {},
  );

  return {
    from: options.from,
    to: options.to,
    timezone: options.timezone,
    totals,
    byDay,
    byModel,
    byProject,
    bySession,
  };
}
