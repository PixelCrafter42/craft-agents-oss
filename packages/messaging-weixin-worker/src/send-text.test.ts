import { describe, expect, it } from 'bun:test'
import { sendTextWithPersistedFallback } from './send-text'

describe('sendTextWithPersistedFallback', () => {
  it('returns immediately after a successful native send', async () => {
    let nativeCalls = 0
    let fallbackCalls = 0

    const result = await sendTextWithPersistedFallback(
      async () => { nativeCalls += 1 },
      async () => {
        fallbackCalls += 1
        return 'fallback-message'
      },
    )

    expect(result).toEqual({ usedFallback: false })
    expect(nativeCalls).toBe(1)
    expect(fallbackCalls).toBe(0)
  })

  it('uses the persisted token exactly once for the eligible missing-context error', async () => {
    let fallbackCalls = 0

    const result = await sendTextWithPersistedFallback(
      async () => { throw new Error('sendMessage ret=-2 errmsg=(none)') },
      async () => {
        fallbackCalls += 1
        return 'persisted-message'
      },
    )

    expect(result).toEqual({ usedFallback: true, messageId: 'persisted-message' })
    expect(fallbackCalls).toBe(1)
  })

  it('does not fall back for authentication or other native send errors', async () => {
    let fallbackCalls = 0

    await expect(sendTextWithPersistedFallback(
      async () => { throw new Error('sendMessage ret=401 errmsg=unauthorized') },
      async () => {
        fallbackCalls += 1
        return 'should-not-send'
      },
    )).rejects.toThrow('unauthorized')
    expect(fallbackCalls).toBe(0)
  })

  it('clears a stale persisted context path and retries without a token', async () => {
    let persistedCalls = 0
    let tokenlessCalls = 0

    const result = await sendTextWithPersistedFallback(
      async () => { throw new Error('sendMessage ret=-2 errmsg=(none)') },
      async () => {
        persistedCalls += 1
        throw new Error('sendMessage ret=(none) errcode=-14 errmsg=session timeout')
      },
      async () => {
        tokenlessCalls += 1
        return 'tokenless-message'
      },
    )

    expect(result).toEqual({ usedFallback: true, messageId: 'tokenless-message' })
    expect(persistedCalls).toBe(1)
    expect(tokenlessCalls).toBe(1)
  })

  it('retries a native session-expired failure directly without a token', async () => {
    let persistedCalls = 0

    const result = await sendTextWithPersistedFallback(
      async () => { throw new Error('sendMessage ret=-14 errmsg=session timeout') },
      async () => {
        persistedCalls += 1
        return 'should-not-send'
      },
      async () => 'tokenless-message',
    )

    expect(result).toEqual({ usedFallback: true, messageId: 'tokenless-message' })
    expect(persistedCalls).toBe(0)
  })

  it('does not retry unrelated persisted-token failures without a token', async () => {
    let tokenlessCalls = 0

    await expect(sendTextWithPersistedFallback(
      async () => { throw new Error('sendMessage ret=-2 errmsg=(none)') },
      async () => { throw new Error('sendMessage ret=401 errmsg=unauthorized') },
      async () => {
        tokenlessCalls += 1
        return 'should-not-send'
      },
    )).rejects.toThrow('unauthorized')
    expect(tokenlessCalls).toBe(0)
  })
})
