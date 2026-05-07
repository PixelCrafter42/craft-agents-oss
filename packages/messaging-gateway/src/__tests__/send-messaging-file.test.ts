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

function makeAdapter(platform: PlatformType, connected = true): PlatformAdapter & { files: FileCall[] } {
  const files: FileCall[] = []
  const capabilities: AdapterCapabilities = {
    messageEditing: platform === 'telegram' || platform === 'lark',
    inlineButtons: platform === 'telegram' || platform === 'lark',
    maxButtons: 3,
    maxMessageLength: 4096,
    markdown: platform === 'telegram' ? 'v2' : platform === 'lark' ? 'lark-post' : 'whatsapp',
    webhookSupport: false,
  }

  return {
    platform,
    capabilities,
    files,
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
})
