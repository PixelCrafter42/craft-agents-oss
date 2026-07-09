import { describe, expect, it } from 'bun:test'
import { getPiModelsForAuthProvider } from '../models-pi.ts'

describe('xai-auth model catalog', () => {
  it('returns the Grok subscription OAuth models with Grok 4.5 first', () => {
    const models = getPiModelsForAuthProvider('xai-auth')
    expect(models[0]?.id).toBe('pi/grok-4.5')
    expect(models.map(m => m.id)).toContain('pi/grok-4.3')
    expect(models.map(m => m.id)).toContain('pi/grok-build')
    expect(models.every(m => m.provider === 'pi')).toBe(true)
  })
})
