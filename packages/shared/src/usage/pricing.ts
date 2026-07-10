import type { UsagePriceSnapshot } from './types.ts';

export interface UsageCostEstimateInput {
  provider?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface UsageCostEstimate {
  costUsd: number;
  priceSnapshot: UsagePriceSnapshot;
}

interface ModelPrice extends UsagePriceSnapshot {
  match: (normalizedModel: string, provider?: string) => boolean;
}

function normalizeModel(model: string): string {
  return model.trim().toLowerCase().replace(/^pi\//, '').split('/').pop() ?? '';
}

function exact(modelId: string, price: Omit<UsagePriceSnapshot, 'source'> & { source?: string }): ModelPrice {
  const normalized = normalizeModel(modelId);
  return {
    ...price,
    source: price.source ?? `local:${normalized}`,
    match: (model) => model === normalized,
  };
}

const MODEL_PRICES: ModelPrice[] = [
  // xAI OAuth models registered by packages/pi-agent-server/src/xai-provider-extension.ts.
  exact('grok-4.5', { inputUsdPerMillion: 2, outputUsdPerMillion: 6, cacheReadUsdPerMillion: 0.5, cacheCreationUsdPerMillion: 0, source: 'local:xai-provider-extension' }),
  exact('grok-4.3', { inputUsdPerMillion: 1.25, outputUsdPerMillion: 2.5, cacheReadUsdPerMillion: 0.2, cacheCreationUsdPerMillion: 0, source: 'local:xai-provider-extension' }),
  exact('grok-build', { inputUsdPerMillion: 1, outputUsdPerMillion: 2, cacheReadUsdPerMillion: 0.2, cacheCreationUsdPerMillion: 0.2, source: 'local:xai-provider-extension' }),
  exact('grok-composer-2.5-fast', { inputUsdPerMillion: 3, outputUsdPerMillion: 15, cacheReadUsdPerMillion: 0.5, cacheCreationUsdPerMillion: 0, source: 'local:xai-provider-extension' }),
  exact('grok-4.20-0309-reasoning', { inputUsdPerMillion: 1.25, outputUsdPerMillion: 2.5, cacheReadUsdPerMillion: 0.2, cacheCreationUsdPerMillion: 0, source: 'local:xai-provider-extension' }),
  exact('grok-4.20-0309-non-reasoning', { inputUsdPerMillion: 1.25, outputUsdPerMillion: 2.5, cacheReadUsdPerMillion: 0.2, cacheCreationUsdPerMillion: 0, source: 'local:xai-provider-extension' }),
  exact('grok-4.20-multi-agent-0309', { inputUsdPerMillion: 1.25, outputUsdPerMillion: 2.5, cacheReadUsdPerMillion: 0.2, cacheCreationUsdPerMillion: 0, source: 'local:xai-provider-extension' }),
];

export function getUsageModelPrice(model: string, provider?: string): UsagePriceSnapshot | null {
  const normalized = normalizeModel(model);
  if (!normalized) return null;

  const match = MODEL_PRICES.find(price => price.match(normalized, provider));
  if (!match) return null;

  const {
    inputUsdPerMillion,
    outputUsdPerMillion,
    cacheReadUsdPerMillion,
    cacheCreationUsdPerMillion,
    source,
  } = match;
  return {
    inputUsdPerMillion,
    outputUsdPerMillion,
    ...(cacheReadUsdPerMillion !== undefined ? { cacheReadUsdPerMillion } : {}),
    ...(cacheCreationUsdPerMillion !== undefined ? { cacheCreationUsdPerMillion } : {}),
    source,
  };
}

export function estimateUsageCost(input: UsageCostEstimateInput): UsageCostEstimate | null {
  const price = getUsageModelPrice(input.model, input.provider);
  if (!price) return null;

  const cacheReadTokens = Math.max(0, input.cacheReadTokens ?? 0);
  const cacheCreationTokens = Math.max(0, input.cacheCreationTokens ?? 0);
  const baseInputTokens = Math.max(0, input.inputTokens - cacheReadTokens - cacheCreationTokens);
  const outputTokens = Math.max(0, input.outputTokens);

  const inputCost = baseInputTokens * price.inputUsdPerMillion / 1_000_000;
  const outputCost = outputTokens * price.outputUsdPerMillion / 1_000_000;
  const cacheReadCost = cacheReadTokens * (price.cacheReadUsdPerMillion ?? price.inputUsdPerMillion) / 1_000_000;
  const cacheCreationCost = cacheCreationTokens * (price.cacheCreationUsdPerMillion ?? price.inputUsdPerMillion) / 1_000_000;

  return {
    costUsd: inputCost + outputCost + cacheReadCost + cacheCreationCost,
    priceSnapshot: price,
  };
}
