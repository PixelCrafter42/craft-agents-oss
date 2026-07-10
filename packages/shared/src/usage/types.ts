export type UsageCostSource = 'sdk' | 'estimated' | 'unknown' | 'legacy';

export interface UsagePriceSnapshot {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cacheReadUsdPerMillion?: number;
  cacheCreationUsdPerMillion?: number;
  source: string;
}

export interface UsageRecordV1 {
  version: 1;
  id: string;
  timestamp: number;
  sessionId: string;
  projectId?: string;
  llmConnection?: string;
  provider?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number | null;
  costSource: UsageCostSource;
  priceSnapshot?: UsagePriceSnapshot;
  contextWindow?: number;
  legacyEstimate?: boolean;
}

export interface UsageQuery {
  from?: number;
  to?: number;
  timezone?: string;
  includeLegacy?: boolean;
}

export interface UsageTotals {
  count: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number;
  unknownCostCount: number;
  legacyEstimateCount: number;
}

export interface UsageGroup {
  key: string;
  label: string;
  totals: UsageTotals;
  sessionDeleted?: boolean;
  legacyEstimate?: boolean;
}

export interface UsageDayGroup {
  date: string;
  totals: UsageTotals;
}

export interface UsageReport {
  from: number;
  to: number;
  timezone: string;
  totals: UsageTotals;
  byDay: UsageDayGroup[];
  byModel: UsageGroup[];
  byProject: UsageGroup[];
  bySession: UsageGroup[];
}
