/**
 * Calculate the displayed percentage of a model's context window in use.
 *
 * Token usage can briefly exceed the advertised context window while a
 * provider reports an overflow, so the UI-facing value is clamped to 100.
 * Invalid or unavailable measurements return null instead of implying 0%.
 */
export function calculateContextUsagePercent(
  usedTokens: number | null | undefined,
  contextWindow: number | null | undefined,
): number | null {
  if (
    typeof usedTokens !== 'number'
    || !Number.isFinite(usedTokens)
    || usedTokens < 0
    || typeof contextWindow !== 'number'
    || !Number.isFinite(contextWindow)
    || contextWindow <= 0
  ) {
    return null
  }

  return Math.min(100, Math.round((usedTokens / contextWindow) * 100))
}
