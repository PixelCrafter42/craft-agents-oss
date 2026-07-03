import { describe, expect, it } from 'bun:test'
import {
  isMissingContextTokenErrorMessage,
  shouldUsePersistedContextTokenFallback,
} from './send-error'

describe('Weixin send error handling', () => {
  it('falls back when native send has no context token', () => {
    expect(isMissingContextTokenErrorMessage('context_token is required')).toBe(true)
    expect(shouldUsePersistedContextTokenFallback(new Error('contextToken missing'))).toBe(true)
  })

  it('falls back on native send ret=-2', () => {
    expect(shouldUsePersistedContextTokenFallback(new Error('sendMessage ret=-2 errmsg=(none)'))).toBe(true)
  })

  it('does not fall back for unrelated native send errors', () => {
    expect(shouldUsePersistedContextTokenFallback(new Error('sendMessage ret=401 errmsg=unauthorized'))).toBe(false)
  })
})
