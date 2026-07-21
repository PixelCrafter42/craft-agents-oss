import { describe, expect, it } from 'bun:test'
import {
  describeWeixinSendResponseError,
  isExpiredContextTokenError,
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

  it('recognizes expired context tokens without treating other failures as expired', () => {
    expect(isExpiredContextTokenError(new Error('sendMessage ret=(none) errcode=-14 errmsg=session timeout'))).toBe(true)
    expect(isExpiredContextTokenError(new Error('sendMessage ret=-14 errmsg=session timeout'))).toBe(true)
    expect(isExpiredContextTokenError(new Error('sendMessage ret=401 errmsg=unauthorized'))).toBe(false)
  })

  it('does not hide an errcode failure when ret is zero', () => {
    const message = describeWeixinSendResponseError({ ret: 0, errcode: -14, errmsg: 'session timeout' })
    expect(message).toBe('sendMessage ret=0 errcode=-14 errmsg=session timeout')
    expect(describeWeixinSendResponseError({ ret: 0, errcode: 0 })).toBeUndefined()
  })
})
