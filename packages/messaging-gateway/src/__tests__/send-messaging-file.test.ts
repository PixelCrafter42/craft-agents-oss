import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ISessionManager } from '@craft-agent/server-core/handlers/session-manager-interface'
import {
  getSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
} from '@craft-agent/shared/agent/session-scoped-tool-callback-registry'
import { MessagingGateway } from '../gateway'
import type {
  AdapterCapabilities,
  PlatformAdapter,
  PlatformType,
  SendOptions,
  SentMessage,
} from '../types'

interface FileCall {
  channelId: string
  fileName: string
  caption?: string
  threadId?: number
  size: number
}

type RichFileCall = FileCall

function makeSessionManager(): ISessionManager {
  return {
    getSessions: () => [],
    getSession: async () => null,
    createSession: async () => { throw new Error('not implemented') },
    sendMessage: async () => {},
    cancelProcessing: async () => {},
    respondToPermission: () => true,
  } as unknown as ISessionManager
}

function makeAdapter(
  platform: PlatformType,
  connected = true,
  richMode?: 'success' | 'fail',
): PlatformAdapter & { files: FileCall[]; richFiles: RichFileCall[] } {
  const files: FileCall[] = []
  const richFiles: RichFileCall[] = []
  const capabilities: AdapterCapabilities = {
    messageEditing: platform === 'telegram' || platform === 'lark',
    inlineButtons: platform === 'telegram' || platform === 'lark',
    maxButtons: 3,
    maxMessageLength: 4096,
    markdown: platform === 'telegram' ? 'v2' : platform === 'lark' ? 'lark-post' : 'whatsapp',
    webhookSupport: false,
  }

  const adapter: PlatformAdapter & { files: FileCall[]; richFiles: RichFileCall[] } = {
    platform,
    capabilities,
    files,
    richFiles,
    async initialize() {},
    async destroy() {},
    isConnected: () => connected,
    onMessage() {},
    onButtonPress() {},
    async sendText(channelId) {
      return { platform, channelId, messageId: 'text-1' } as SentMessage
    },
    async editMessage() {},
    async sendButtons(channelId) {
      return { platform, channelId, messageId: 'buttons-1' } as SentMessage
    },
    async sendTyping() {},
    async sendFile(channelId: string, file: Buffer, fileName: string, caption?: string, opts?: SendOptions) {
      files.push({ channelId, fileName, caption, threadId: opts?.threadId, size: file.length })
      return { platform, channelId, messageId: `${platform}-file-1` } as SentMessage
    },
  }
  if (richMode) {
    adapter.sendRichMedia = async (channelId, file, fileName, caption, opts) => {
      richFiles.push({ channelId, fileName, caption, threadId: opts?.threadId, size: file.length })
      if (richMode === 'fail') throw new Error('rich media rejected')
      return { platform, channelId, messageId: `${platform}-rich-file-1` }
    }
  }
  return adapter
}

function makeGateway(): MessagingGateway {
  return new MessagingGateway({
    sessionManager: makeSessionManager(),
    workspaceId: 'ws-1',
    storageDir: mkdtempSync(join(tmpdir(), 'messaging-gateway-test-')),
  })
}

function writeTempFile(name = 'report.txt', content = 'hello'): string {
  const dir = mkdtempSync(join(tmpdir(), 'messaging-file-'))
  const filePath = join(dir, name)
  writeFileSync(filePath, content)
  return filePath
}

describe('MessagingGateway send_messaging_file callback', () => {
  afterEach(() => {
    unregisterSessionScopedToolCallbacks('sess-1')
  })

  it('sends to Telegram by default before WeChat and Lark', async () => {
    const gateway = makeGateway()
    const telegram = makeAdapter('telegram')
    const weixin = makeAdapter('weixin')
    const lark = makeAdapter('lark')
    gateway.registerAdapter(telegram)
    gateway.registerAdapter(weixin)
    gateway.registerAdapter(lark)
    gateway.getBindingStore().bind('ws-1', 'sess-1', 'lark', 'lark-1')
    gateway.getBindingStore().bind('ws-1', 'sess-1', 'weixin', 'wx-1')
    gateway.getBindingStore().bind('ws-1', 'sess-1', 'telegram', 'tg-1')

    const filePath = writeTempFile('report.txt', 'telegram-first')
    const sendFile = getSessionScopedToolCallbacks('sess-1')!.sendMessagingFileFn!
    const result = await sendFile({ path: filePath, caption: 'Report' })

    expect(result).toMatchObject({ platform: 'telegram', channelId: 'tg-1', fileName: 'report.txt' })
    expect(telegram.files).toEqual([{ channelId: 'tg-1', fileName: 'report.txt', caption: 'Report', threadId: undefined, size: 14 }])
    expect(weixin.files).toEqual([])
    expect(lark.files).toEqual([])
  })

  it('falls back to WeChat, then Lark, when earlier platforms are not connected', async () => {
    const gateway = makeGateway()
    const telegram = makeAdapter('telegram', false)
    const weixin = makeAdapter('weixin', false)
    const lark = makeAdapter('lark')
    gateway.registerAdapter(telegram)
    gateway.registerAdapter(weixin)
    gateway.registerAdapter(lark)
    gateway.getBindingStore().bind('ws-1', 'sess-1', 'telegram', 'tg-1')
    gateway.getBindingStore().bind('ws-1', 'sess-1', 'weixin', 'wx-1')
    gateway.getBindingStore().bind('ws-1', 'sess-1', 'lark', 'lark-1')

    const sendFile = getSessionScopedToolCallbacks('sess-1')!.sendMessagingFileFn!
    const result = await sendFile({ path: writeTempFile() })

    expect(result.platform).toBe('lark')
    expect(telegram.files).toEqual([])
    expect(weixin.files).toEqual([])
    expect(lark.files[0]?.channelId).toBe('lark-1')
  })

  it('requires channelId when multiple Telegram channels are connected', async () => {
    const gateway = makeGateway()
    const telegram = makeAdapter('telegram')
    gateway.registerAdapter(telegram)
    gateway.getBindingStore().bind('ws-1', 'sess-1', 'telegram', 'tg-1')
    gateway.getBindingStore().bind('ws-1', 'sess-1', 'telegram', 'tg-2')

    const sendFile = getSessionScopedToolCallbacks('sess-1')!.sendMessagingFileFn!

    await expect(sendFile({ path: writeTempFile() })).rejects.toThrow('specify channelId')
  })

  it('uses an explicit channelId and sanitized display name', async () => {
    const gateway = makeGateway()
    const telegram = makeAdapter('telegram')
    gateway.registerAdapter(telegram)
    gateway.getBindingStore().bind('ws-1', 'sess-1', 'telegram', 'tg-1')
    gateway.getBindingStore().bind('ws-1', 'sess-1', 'telegram', 'tg-2')

    const sendFile = getSessionScopedToolCallbacks('sess-1')!.sendMessagingFileFn!
    const result = await sendFile({ path: writeTempFile('source.txt'), name: 'clean:name?.txt', channelId: 'tg-2' })

    expect(result).toMatchObject({ platform: 'telegram', channelId: 'tg-2', fileName: 'clean_name_.txt' })
    expect(telegram.files).toEqual([{ channelId: 'tg-2', fileName: 'clean_name_.txt', caption: undefined, threadId: undefined, size: 5 }])
  })

  it('passes Telegram topic threadId when selecting a topic binding', async () => {
    const gateway = makeGateway()
    const telegram = makeAdapter('telegram')
    gateway.registerAdapter(telegram)
    gateway.getBindingStore().bind('ws-1', 'sess-1', 'telegram', 'tg-1', undefined, undefined, 101)
    gateway.getBindingStore().bind('ws-1', 'sess-1', 'telegram', 'tg-1', undefined, undefined, 202)

    const sendFile = getSessionScopedToolCallbacks('sess-1')!.sendMessagingFileFn!
    const result = await sendFile({ path: writeTempFile('topic.txt'), channelId: 'tg-1', threadId: 202 })

    expect(result).toMatchObject({ platform: 'telegram', channelId: 'tg-1', threadId: 202 })
    expect(telegram.files).toEqual([{ channelId: 'tg-1', fileName: 'topic.txt', caption: undefined, threadId: 202, size: 5 }])
  })

  it('uses Telegram rich media for supported AI attachments without a duplicate file send', async () => {
    const gateway = makeGateway()
    const telegram = makeAdapter('telegram', true, 'success')
    gateway.registerAdapter(telegram)
    gateway.getBindingStore().bind('ws-1', 'sess-1', 'telegram', 'tg-1', undefined, undefined, 303)

    const sendFile = getSessionScopedToolCallbacks('sess-1')!.sendMessagingFileFn!
    const result = await sendFile({
      path: writeTempFile('chart.png', 'image-bytes'),
      caption: '# Results',
      channelId: 'tg-1',
      threadId: 303,
    })

    expect(result).toMatchObject({ messageId: 'telegram-rich-file-1', threadId: 303 })
    expect(telegram.richFiles).toEqual([{
      channelId: 'tg-1',
      fileName: 'chart.png',
      caption: '# Results',
      threadId: 303,
      size: 11,
    }])
    expect(telegram.files).toEqual([])
  })

  it('falls back once to the existing attachment send when rich media is rejected', async () => {
    const gateway = makeGateway()
    const telegram = makeAdapter('telegram', true, 'fail')
    gateway.registerAdapter(telegram)
    gateway.getBindingStore().bind('ws-1', 'sess-1', 'telegram', 'tg-1')

    const sendFile = getSessionScopedToolCallbacks('sess-1')!.sendMessagingFileFn!
    const result = await sendFile({ path: writeTempFile('chart.png', 'image-bytes') })

    expect(result.messageId).toBe('telegram-file-1')
    expect(telegram.richFiles).toHaveLength(1)
    expect(telegram.files).toHaveLength(1)
  })
})
