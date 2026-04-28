import { describe, expect, it } from 'bun:test'
import { TelegramAdapter } from './index'
import { formatPlainTextForTelegram } from './format'

interface ApiCall {
  method: 'sendMessage' | 'editMessageText' | 'sendDocument'
  chatId: number
  messageId?: number
  text?: string
  other?: Record<string, unknown>
}

interface FakeTelegramApi {
  sendMessage?: (
    chatId: number,
    text: string,
    other?: Record<string, unknown>,
  ) => Promise<{ message_id: number }>
  editMessageText?: (
    chatId: number,
    messageId: number,
    text: string,
    other?: Record<string, unknown>,
  ) => Promise<unknown>
  sendDocument?: (
    chatId: number,
    document: unknown,
    other?: Record<string, unknown>,
  ) => Promise<{ message_id: number }>
}

function makeAdapter(api: FakeTelegramApi): TelegramAdapter {
  const adapter = new TelegramAdapter()
  ;(adapter as unknown as { bot: { api: FakeTelegramApi; token: string } }).bot = {
    api,
    token: 'TEST_TOKEN',
  }
  return adapter
}

function entityParseError(): Error {
  const err = new Error("Bad Request: can't parse entities: Character '*' is reserved")
  ;(err as Error & { description: string; error_code: number }).description =
    "Bad Request: can't parse entities: Character '*' is reserved"
  ;(err as Error & { description: string; error_code: number }).error_code = 400
  return err
}

describe('TelegramAdapter MarkdownV2 sending', () => {
  it('passes parse_mode for text messages', async () => {
    const calls: ApiCall[] = []
    const adapter = makeAdapter({
      async sendMessage(chatId, text, other) {
        calls.push({ method: 'sendMessage', chatId, text, other })
        return { message_id: 1 }
      },
    })

    await adapter.sendText('42', '**bold**')

    expect(calls).toEqual([
      {
        method: 'sendMessage',
        chatId: 42,
        text: '*bold*',
        other: { parse_mode: 'MarkdownV2' },
      },
    ])
  })

  it('passes parse_mode for message edits', async () => {
    const calls: ApiCall[] = []
    const adapter = makeAdapter({
      async editMessageText(chatId, messageId, text, other) {
        calls.push({ method: 'editMessageText', chatId, messageId, text, other })
        return true
      },
    })

    await adapter.editMessage('42', '7', '_done_')

    expect(calls).toEqual([
      {
        method: 'editMessageText',
        chatId: 42,
        messageId: 7,
        text: '_done_',
        other: { parse_mode: 'MarkdownV2' },
      },
    ])
  })

  it('passes parse_mode alongside inline keyboards', async () => {
    const calls: ApiCall[] = []
    const adapter = makeAdapter({
      async sendMessage(chatId, text, other) {
        calls.push({ method: 'sendMessage', chatId, text, other })
        return { message_id: 2 }
      },
    })

    await adapter.sendButtons('42', '# Plan', [{ id: 'accept', label: 'Accept' }])

    expect(calls).toEqual([
      {
        method: 'sendMessage',
        chatId: 42,
        text: '*Plan*',
        other: {
          parse_mode: 'MarkdownV2',
          reply_markup: {
            inline_keyboard: [[{ text: 'Accept', callback_data: 'accept' }]],
          },
        },
      },
    ])
  })

  it('passes parse_mode for document captions', async () => {
    const calls: ApiCall[] = []
    const adapter = makeAdapter({
      async sendDocument(chatId, _document, other) {
        calls.push({ method: 'sendDocument', chatId, other })
        return { message_id: 3 }
      },
    })

    await adapter.sendFile('42', Buffer.from('hello'), 'hello.txt', '**Full plan**')

    expect(calls).toEqual([
      {
        method: 'sendDocument',
        chatId: 42,
        other: {
          caption: '*Full plan*',
          parse_mode: 'MarkdownV2',
        },
      },
    ])
  })

  it('retries entity parse failures as escaped plain text', async () => {
    const calls: ApiCall[] = []
    let attempt = 0
    const adapter = makeAdapter({
      async sendMessage(chatId, text, other) {
        calls.push({ method: 'sendMessage', chatId, text, other })
        attempt += 1
        if (attempt === 1) throw entityParseError()
        return { message_id: 4 }
      },
    })

    await adapter.sendText('42', '**bold**')

    expect(calls).toHaveLength(2)
    expect(calls[0]?.text).toBe('*bold*')
    expect(calls[1]).toEqual({
      method: 'sendMessage',
      chatId: 42,
      text: formatPlainTextForTelegram('**bold**'),
      other: { parse_mode: 'MarkdownV2' },
    })
  })

  it('does not retry non-entity Telegram failures', async () => {
    const adapter = makeAdapter({
      async sendMessage() {
        throw new Error('Forbidden: bot was blocked by the user')
      },
    })

    await expect(adapter.sendText('42', '**bold**')).rejects.toThrow('Forbidden')
  })
})
