import { describe, expect, test } from 'bun:test'
import { calculateContextUsagePercent } from '../src/utils/context-usage.ts'

describe('calculateContextUsagePercent', () => {
  test('returns the rounded percentage of the full model context window', () => {
    expect(calculateContextUsagePercent(124_000, 200_000)).toBe(62)
    expect(calculateContextUsagePercent(183_616, 200_000)).toBe(92)
  })

  test('supports an empty measured context without treating it as unavailable', () => {
    expect(calculateContextUsagePercent(0, 200_000)).toBe(0)
  })

  test('clamps provider overflow measurements to 100 percent', () => {
    expect(calculateContextUsagePercent(210_000, 200_000)).toBe(100)
  })

  test('returns null for unavailable or invalid measurements', () => {
    expect(calculateContextUsagePercent(undefined, 200_000)).toBeNull()
    expect(calculateContextUsagePercent(10_000, undefined)).toBeNull()
    expect(calculateContextUsagePercent(10_000, 0)).toBeNull()
    expect(calculateContextUsagePercent(-1, 200_000)).toBeNull()
    expect(calculateContextUsagePercent(Number.NaN, 200_000)).toBeNull()
  })
})
