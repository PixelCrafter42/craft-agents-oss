/**
 * Tests for the DM-only guard in the Telegram adapter.
 *
 * Exercising the real grammY Bot#on handlers requires network access
 * (getUpdates polling) and is wasteful for what's effectively a
 * `ctx.chat.type === 'private'` check. Instead we unit-test the exported
 * `isPrivateChat` predicate directly — it's the single source of truth
 * used by every handler — and rely on typecheck + code review to confirm
 * each handler calls it.
 */
import { describe, it, expect } from 'bun:test'
import type { Context } from 'grammy'
import {
  isPrivateChat,
  telegramCallbackEphemeralContext,
  telegramEphemeralReplyTarget,
} from './index'

function ctxWithChatType(type: string | undefined): Context {
  return { chat: type ? { type } : undefined } as unknown as Context
}

describe('isPrivateChat', () => {
  it('accepts private chats', () => {
    expect(isPrivateChat(ctxWithChatType('private'))).toBe(true)
  })

  it('rejects group chats', () => {
    expect(isPrivateChat(ctxWithChatType('group'))).toBe(false)
  })

  it('rejects supergroups', () => {
    expect(isPrivateChat(ctxWithChatType('supergroup'))).toBe(false)
  })

  it('rejects channels', () => {
    expect(isPrivateChat(ctxWithChatType('channel'))).toBe(false)
  })

  it('rejects contexts without a chat', () => {
    expect(isPrivateChat(ctxWithChatType(undefined))).toBe(false)
  })
})

describe('Bot API 10.2 ephemeral context translation', () => {
  it('maps an incoming ephemeral command id and its 15-second deadline', () => {
    const ctx = {
      chat: { id: -1001, type: 'supergroup' },
      from: { id: 123 },
      message: { message_id: 0, ephemeral_message_id: 77, date: 1_000 },
    } as unknown as Context

    expect(telegramEphemeralReplyTarget(ctx)).toEqual({
      recipientId: '123',
      sourceMessageId: '77',
      expiresAt: 1_015_000,
    })
  })

  it('maps callback_query_id and uses receiver_user for ephemeral edits', () => {
    const ctx = {
      chat: { id: -1001, type: 'supergroup' },
      from: { id: 123 },
      callbackQuery: {
        id: 'callback-9',
        message: {
          message_id: 0,
          ephemeral_message_id: 88,
          receiver_user: { id: 456 },
        },
      },
    } as unknown as Context

    expect(telegramCallbackEphemeralContext(ctx, 5_000)).toEqual({
      reply: {
        recipientId: '123',
        interactionId: 'callback-9',
        expiresAt: 20_000,
      },
      source: { recipientId: '456', messageId: '88' },
    })
  })
})
