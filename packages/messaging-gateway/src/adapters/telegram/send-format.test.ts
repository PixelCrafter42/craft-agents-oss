import { describe, expect, it } from 'bun:test'
import { TelegramAdapter } from './index'
import { formatPlainTextForTelegram } from './format'

interface ApiCall {
  method:
    | 'sendMessage'
    | 'editMessageText'
    | 'sendDocument'
    | 'sendVoice'
    | 'sendAudio'
    | 'sendMessageDraft'
    | 'sendRichMessage'
    | 'sendRichMessageDraft'
  chatId: number
  messageId?: number
  draftId?: number
  text?: string
  other?: Record<string, unknown>
  payload?: Record<string, unknown>
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
  sendVoice?: (
    chatId: number,
    voice: unknown,
    other?: Record<string, unknown>,
  ) => Promise<{ message_id: number }>
  sendAudio?: (
    chatId: number,
    audio: unknown,
    other?: Record<string, unknown>,
  ) => Promise<{ message_id: number }>
  sendMessageDraft?: (
    chatId: number,
    draftId: number,
    text: string,
    other?: Record<string, unknown>,
  ) => Promise<true>
  raw?: {
    sendRichMessage?: (payload: Record<string, unknown>) => Promise<{ message_id: number }>
    sendRichMessageDraft?: (payload: Record<string, unknown>) => Promise<true>
  }
  setMyCommands?: (
    commands: readonly { command: string; description: string }[],
    other?: Record<string, unknown>,
  ) => Promise<true>
}

function makeAdapter(api: FakeTelegramApi): TelegramAdapter {
  const adapter = new TelegramAdapter()
  ;(adapter as unknown as { bot: { api: FakeTelegramApi; token: string } }).bot = {
    api: { raw: {}, ...api },
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

  it('sends inline keyboard rows for interactive menus', async () => {
    const calls: ApiCall[] = []
    const adapter = makeAdapter({
      async sendMessage(chatId, text, other) {
        calls.push({ method: 'sendMessage', chatId, text, other })
        return { message_id: 2 }
      },
    })

    await adapter.sendButtonRows('42', 'Menu', [
      [
        { id: 'menu:skills:0', label: 'Skills' },
        { id: 'menu:status', label: 'Status' },
      ],
      [{ id: 'menu:home', label: 'Back' }],
    ])

    expect(calls[0]?.other?.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: 'Skills', callback_data: 'menu:skills:0' },
          { text: 'Status', callback_data: 'menu:status' },
        ],
        [{ text: 'Back', callback_data: 'menu:home' }],
      ],
    })
  })

  it('syncs command menus across Telegram global command scopes', async () => {
    const calls: { commands: readonly { command: string; description: string }[]; other?: Record<string, unknown> }[] = []
    const adapter = makeAdapter({
      async setMyCommands(commands, other) {
        calls.push({ commands, other })
        return true
      },
    })

    await adapter.setCommandMenu([
      { command: 'menu', description: 'Open the interactive menu' },
      { command: 'pair', description: 'Redeem a pairing code' },
    ])

    expect(calls.map((call) => (call.other?.scope as { type: string } | undefined)?.type)).toEqual([
      'default',
      'all_private_chats',
      'all_group_chats',
      'all_chat_administrators',
    ])
    expect(calls.every((call) => call.commands.map((command) => command.command).join(',') === 'menu,pair')).toBe(true)
  })

  it('syncs command menus for the current Telegram chat scope', async () => {
    const calls: { commands: readonly { command: string; description: string }[]; other?: Record<string, unknown> }[] = []
    const adapter = makeAdapter({
      async setMyCommands(commands, other) {
        calls.push({ commands, other })
        return true
      },
    })

    await adapter.setCommandMenu(
      [{ command: 'menu', description: 'Open the interactive menu' }],
      { channelId: '42' },
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.other).toEqual({
      scope: { type: 'chat', chat_id: 42 },
    })
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

  it('sends Telegram-compatible audio files as native voice messages', async () => {
    const calls: ApiCall[] = []
    const adapter = makeAdapter({
      async sendVoice(chatId, _voice, other) {
        calls.push({ method: 'sendVoice', chatId, other })
        return { message_id: 8 }
      },
    })

    await adapter.sendFile('42', Buffer.from('audio'), 'reply.mp3', '**Voice reply**')

    expect(calls).toEqual([
      {
        method: 'sendVoice',
        chatId: 42,
        other: {
          caption: '*Voice reply*',
          parse_mode: 'MarkdownV2',
        },
      },
    ])
  })

  it('falls back from sendVoice to sendAudio for MP3 files', async () => {
    const calls: ApiCall[] = []
    const adapter = makeAdapter({
      async sendVoice(chatId, _voice, other) {
        calls.push({ method: 'sendVoice', chatId, other })
        throw new Error('voice rejected')
      },
      async sendAudio(chatId, _audio, other) {
        calls.push({ method: 'sendAudio', chatId, other })
        return { message_id: 9 }
      },
    })

    await adapter.sendFile('42', Buffer.from('audio'), 'reply.mp3')

    expect(calls.map((c) => c.method)).toEqual(['sendVoice', 'sendAudio'])
  })

  it('streams regular message drafts with MarkdownV2 parse mode', async () => {
    const calls: ApiCall[] = []
    const adapter = makeAdapter({
      async sendMessageDraft(chatId, draftId, text, other) {
        calls.push({ method: 'sendMessageDraft', chatId, draftId, text, other })
        return true
      },
    })

    await adapter.sendMessageDraft('42', 123, '**working**', { threadId: 9 })

    expect(calls).toEqual([
      {
        method: 'sendMessageDraft',
        chatId: 42,
        draftId: 123,
        text: '*working*',
        other: {
          parse_mode: 'MarkdownV2',
          message_thread_id: 9,
        },
      },
    ])
  })

  it('sends rich messages through the raw Bot API', async () => {
    const calls: ApiCall[] = []
    const adapter = makeAdapter({
      raw: {
        async sendRichMessage(payload) {
          calls.push({ method: 'sendRichMessage', chatId: Number(payload.chat_id), payload })
          return { message_id: 10 }
        },
      },
    })

    await adapter.sendRichMessage('42', '# Report\n\n- item', { threadId: 9 })

    expect(calls).toEqual([
      {
        method: 'sendRichMessage',
        chatId: 42,
        payload: {
          chat_id: 42,
          rich_message: { markdown: '# Report\n\n- item' },
          message_thread_id: 9,
        },
      },
    ])
  })

  it('streams rich message drafts through the raw Bot API', async () => {
    const calls: ApiCall[] = []
    const adapter = makeAdapter({
      raw: {
        async sendRichMessageDraft(payload) {
          calls.push({ method: 'sendRichMessageDraft', chatId: Number(payload.chat_id), payload })
          return true
        },
      },
    })

    await adapter.sendRichMessageDraft('42', 456, '# Draft', { threadId: 9 })

    expect(calls).toEqual([
      {
        method: 'sendRichMessageDraft',
        chatId: 42,
        payload: {
          chat_id: 42,
          draft_id: 456,
          rich_message: { markdown: '# Draft' },
          message_thread_id: 9,
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
