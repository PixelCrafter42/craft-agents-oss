import { describe, expect, it } from 'bun:test'
import type { IncomingMessage, MessagingLogger } from '../../types'
import { TelegramAdapter } from './index'

const incomingMessage: IncomingMessage = {
  platform: 'telegram',
  channelId: 'chat-1',
  messageId: 'message-1',
  senderId: 'sender-1',
  text: 'hello',
  timestamp: 1,
  raw: {},
}

function dispatch(adapter: TelegramAdapter, msg = incomingMessage): void {
  ;(adapter as unknown as {
    dispatchIncomingMessage(message: IncomingMessage): void
  }).dispatchIncomingMessage(msg)
}

describe('TelegramAdapter incoming dispatch', () => {
  it('does not block polling while the gateway processes a long agent turn', () => {
    const adapter = new TelegramAdapter()
    let handlerStarted = false

    adapter.onMessage(async () => {
      handlerStarted = true
      await new Promise<void>(() => {})
    })

    expect(dispatch(adapter)).toBeUndefined()
    expect(handlerStarted).toBe(true)
  })

  it('logs asynchronous handler failures instead of leaking a rejection', async () => {
    const adapter = new TelegramAdapter()
    const errors: unknown[][] = []
    const logger: MessagingLogger = {
      info: () => {},
      warn: () => {},
      error: (...args: unknown[]) => { errors.push(args) },
      child: () => logger,
    }
    ;(adapter as unknown as { log: MessagingLogger }).log = logger
    adapter.onMessage(async () => {
      throw new Error('route failed')
    })

    dispatch(adapter)
    await Promise.resolve()
    await Promise.resolve()

    expect(errors).toHaveLength(1)
    expect(errors[0]?.[0]).toBe('[telegram] inbound message handler failed:')
    expect(errors[0]?.[1]).toMatchObject({ message: 'route failed' })
  })
})
