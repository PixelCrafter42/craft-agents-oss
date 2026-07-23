/**
 * Lark / Feishu adapter backed by the official high-level LarkChannel.
 *
 * LarkChannel owns WebSocket lifecycle, event normalization, CardKit streams,
 * media upload/download, retries, and rate limiting. Craft remains the source
 * of truth for workspace bindings and access-control decisions.
 */

import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import * as lark from '@larksuiteoapi/node-sdk'
import type {
  AdapterCapabilities,
  ButtonPress,
  IncomingAttachment,
  IncomingMessage,
  InlineButton,
  MessagingLogger,
  NativeStreamHandle,
  PlatformAdapter,
  PlatformConfig,
  SendOptions,
  SentMessage,
} from '../../types'
import {
  buildClearedCard,
  buildLarkCard,
  buildMarkdownCard,
  isLarkEditExpiredError,
  LARK_MAX_BUTTONS,
} from './card'

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
const STREAM_MAX_ELEMENT_CHARS = 28_000
// Feishu auto-closes streaming mode after ten minutes. Rotate early so a
// long-running tool/agent turn can continue on a clearly labelled card.
const STREAM_MAX_DURATION_MS = 9 * 60 * 1000
const EPHEMERAL_CONTEXT_TTL_MS = 10 * 60 * 1000
const MAX_EPHEMERAL_CONTEXTS = 512
const ATTACHMENT_ONLY_MESSAGE_TYPES = new Set(['audio', 'image', 'file', 'video', 'media', 'sticker'])

const NOOP_LOGGER: MessagingLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
}

export interface LarkCredentials {
  appId: string
  appSecret: string
  domain: 'lark' | 'feishu'
}

export function parseLarkCredentials(token: string | undefined): LarkCredentials {
  if (!token) throw new Error('Lark credentials are missing')
  let parsed: unknown
  try {
    parsed = JSON.parse(token)
  } catch {
    throw new Error('Lark credentials are not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Lark credentials must be a JSON object')
  }
  const { appId, appSecret, domain } = parsed as Record<string, unknown>
  if (typeof appId !== 'string' || !appId) throw new Error('Lark credentials are missing `appId`')
  if (typeof appSecret !== 'string' || !appSecret) throw new Error('Lark credentials are missing `appSecret`')
  if (domain !== 'lark' && domain !== 'feishu') {
    throw new Error('Lark credentials `domain` must be "lark" or "feishu"')
  }
  return { appId, appSecret, domain }
}

function resolveLarkDomain(domain: LarkCredentials['domain']): lark.Domain {
  return domain === 'feishu' ? lark.Domain.Feishu : lark.Domain.Lark
}

function toLarkSendOptions(opts?: SendOptions): lark.SendOptions | undefined {
  if (!opts?.replyToMessageId && !opts?.replyInThread) return undefined
  return {
    ...(opts.replyToMessageId ? { replyTo: opts.replyToMessageId } : {}),
    ...(opts.replyInThread ? { replyInThread: true } : {}),
  }
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'audio/opus': '.opus',
  'audio/ogg': '.oga',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'application/pdf': '.pdf',
}

function normalizeMimeType(value: string | undefined): string | undefined {
  const normalized = value?.split(';', 1)[0]?.trim().toLowerCase()
  return normalized && normalized !== 'application/octet-stream' ? normalized : undefined
}

function responseHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined
  const headerRecord = headers as Record<string, unknown> & { get?: (name: string) => unknown }
  const fromGetter = typeof headerRecord.get === 'function' ? headerRecord.get(name) : undefined
  if (typeof fromGetter === 'string') return fromGetter
  const target = name.toLowerCase()
  for (const [key, value] of Object.entries(headerRecord)) {
    if (key.toLowerCase() === target && typeof value === 'string') return value
  }
  return undefined
}

async function readResourceBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.byteLength
    if (total > MAX_ATTACHMENT_BYTES) {
      stream.destroy()
      throw new Error(`attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, total)
}

function extensionForResource(resource: lark.ResourceDescriptor, mimeType?: string): string {
  const existing = extname(resource.fileName ?? '')
  if (existing) return existing
  const fromMime = mimeType ? EXTENSION_BY_MIME[mimeType] : undefined
  if (fromMime) return fromMime
  switch (resource.type) {
    case 'image': return '.jpg'
    case 'audio': return '.opus'
    case 'video': return '.mp4'
    case 'sticker': return '.webp'
    default: return '.bin'
  }
}

function mimeForFilename(
  filename: string,
  type: lark.ResourceDescriptor['type'],
  responseMimeType?: string,
): string | undefined {
  if (responseMimeType) return responseMimeType
  const ext = extname(filename).toLowerCase()
  const byExt: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
    '.webp': 'image/webp', '.opus': 'audio/opus', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.pdf': 'application/pdf',
  }
  return byExt[ext] ??
    (type === 'image' || type === 'sticker' ? 'image/jpeg' : undefined) ??
    (type === 'audio' ? 'audio/opus' : undefined) ??
    (type === 'video' ? 'video/mp4' : undefined)
}

function incomingType(resource: lark.ResourceDescriptor): IncomingAttachment['type'] {
  switch (resource.type) {
    case 'image': return 'photo'
    case 'audio': return 'audio'
    case 'video': return 'video'
    case 'sticker': return 'photo'
    default: return 'document'
  }
}

interface StreamRecord {
  handle: NativeStreamHandle
  controller?: lark.MarkdownStreamController
  ready: Promise<void>
  resolveReady: () => void
  rejectReady: (error: unknown) => void
  producerDone: Promise<void>
  resolveProducer: () => void
  result: Promise<lark.SendResult>
  lastMarkdown: string
  channelId: string
  startedAt: number
  /** Exact answer prefix already finalized into preceding continuation cards. */
  segmentPrefix: string
  sendOptions?: lark.SendOptions
}

function streamSegmentMarkdown(fullMarkdown: string, segmentPrefix: string): string {
  if (!segmentPrefix) return fullMarkdown
  const tail = (fullMarkdown.startsWith(segmentPrefix)
    ? fullMarkdown.slice(segmentPrefix.length)
    : fullMarkdown).trimStart()
  return `↪️ **Continued**\n\n${tail || '💭 thinking…'}`
}

export class LarkAdapter implements PlatformAdapter {
  readonly platform = 'lark' as const
  readonly capabilities: AdapterCapabilities = {
    messageEditing: true,
    inlineButtons: true,
    nativeStreaming: true,
    contextualReplies: true,
    ephemeralCards: true,
    richMedia: true,
    maxButtons: LARK_MAX_BUTTONS,
    maxMessageLength: 30_000,
    markdown: 'lark-post',
    webhookSupport: false,
  }

  private channel: lark.LarkChannel | null = null
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null
  private buttonHandler: ((press: ButtonPress) => Promise<void>) | null = null
  private connected = false
  private log: MessagingLogger = NOOP_LOGGER
  private runtimeCallback: PlatformConfig['onRuntimeState']
  private unsubs: Array<() => void> = []
  private readonly cardBodies = new Map<string, string>()
  private readonly streams = new Map<string, StreamRecord>()
  private readonly ephemeralContexts = new Map<string, number>()

  constructor(
    private readonly createChannel: (options: lark.LarkChannelOptions) => lark.LarkChannel =
      (options) => new lark.LarkChannel(options),
  ) {}

  async getBotInfo(): Promise<{ name?: string } | null> {
    const name = this.channel?.botIdentity?.name
    return name ? { name } : null
  }

  getConnectionStatus(): ReturnType<lark.LarkChannel['getConnectionStatus']> {
    return this.channel?.getConnectionStatus()
  }

  async initialize(config: PlatformConfig): Promise<void> {
    await this.destroy()
    this.log = config.logger ?? NOOP_LOGGER
    this.runtimeCallback = config.onRuntimeState
    const creds = parseLarkCredentials(config.token)
    this.runtimeCallback?.('connecting')

    const channel = this.createChannel({
      appId: creds.appId,
      appSecret: creds.appSecret,
      domain: resolveLarkDomain(creds.domain),
      transport: 'websocket',
      source: 'craft-agents',
      loggerLevel: lark.LoggerLevel.warn,
      handshakeTimeoutMs: 20_000,
      includeRawEvent: false,
      policy: {
        dmMode: 'open',
        requireMention: true,
        respondToMentionAll: false,
      },
      safety: {
        dedup: { ttl: 10 * 60 * 1000, maxEntries: 2_000 },
        chatQueue: { enabled: true },
        staleMessageWindowMs: 10 * 60 * 1000,
      },
      outbound: {
        markdownConverter: 'builtin',
        streamThrottleMs: 120,
        streamThrottleChars: 24,
        streamInitialText: '💭 thinking…',
        streamMaxElementChars: STREAM_MAX_ELEMENT_CHARS,
        retry: { maxAttempts: 3, baseDelayMs: 500 },
      },
    })
    this.channel = channel

    this.unsubs.push(channel.on('message', async (message) => this.handleIncomingMessage(message)))
    this.unsubs.push(channel.on('cardAction', (event) => {
      // Return from the platform callback immediately. CardKit rejects card
      // updates while a callback is still in progress, so gateway ACL/action
      // handling runs on the next event-loop turn.
      setImmediate(() => {
        void this.handleCardAction(event).catch((error) => {
          this.log.warn('[lark] card action handling failed', {
            event: 'lark_card_action_failed',
            error: error instanceof Error ? error.message : String(error),
          })
        })
      })
    }))
    this.unsubs.push(channel.on('reconnecting', () => {
      this.runtimeCallback?.('reconnecting')
      this.log.info('[lark] reconnecting', { event: 'lark_reconnecting' })
    }))
    this.unsubs.push(channel.on('reconnected', () => {
      this.connected = true
      this.runtimeCallback?.('connected')
      this.log.info('[lark] reconnected', { event: 'lark_reconnected' })
    }))
    this.unsubs.push(channel.on('error', (error) => {
      const detail = error.message || error.code
      if (error.code === 'permission_denied') {
        this.runtimeCallback?.('degraded', detail)
      } else if (!this.connected) {
        this.runtimeCallback?.('error', detail)
      }
      this.log.error('[lark] channel error', {
        event: 'lark_channel_error',
        code: error.code,
        error: detail,
      })
    }))

    try {
      await channel.connect()
      this.connected = true
      this.runtimeCallback?.('connected')
      this.log.info('[lark] connected', {
        event: 'lark_connected',
        domain: creds.domain,
        identity: channel.botIdentity?.name,
      })
    } catch (error) {
      for (const off of this.unsubs.splice(0)) off()
      this.connected = false
      this.channel = null
      await channel.disconnect().catch(() => {})
      this.runtimeCallback?.('error', error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  async destroy(): Promise<void> {
    for (const off of this.unsubs.splice(0)) off()
    for (const stream of this.streams.values()) stream.resolveProducer()
    this.streams.clear()
    const channel = this.channel
    this.channel = null
    this.connected = false
    this.cardBodies.clear()
    this.ephemeralContexts.clear()
    if (channel) await channel.disconnect().catch(() => {})
  }

  isConnected(): boolean {
    return this.connected
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler
  }

  onButtonPress(handler: (press: ButtonPress) => Promise<void>): void {
    this.buttonHandler = handler
  }

  async sendText(channelId: string, text: string, opts?: SendOptions): Promise<SentMessage> {
    const channel = this.requireChannel()
    try {
      const result = await channel.send(
        channelId,
        { card: buildMarkdownCard(text) },
        toLarkSendOptions(opts),
      )
      this.cardBodies.set(result.messageId, text)
      return { platform: 'lark', channelId, messageId: result.messageId }
    } catch (error) {
      this.markCardKitDegraded(error)
      const fallback = await channel.send(channelId, { text }, toLarkSendOptions(opts))
      return { platform: 'lark', channelId, messageId: fallback.messageId }
    }
  }

  async editMessage(
    _channelId: string,
    messageId: string,
    text: string,
    _opts?: SendOptions,
  ): Promise<void> {
    const channel = this.requireChannel()
    try {
      if (this.cardBodies.has(messageId)) {
        await channel.updateCard(messageId, buildMarkdownCard(text))
        this.cardBodies.set(messageId, text)
      } else {
        await channel.editMessage(messageId, text)
      }
    } catch (error) {
      this.markCardKitDegraded(error)
      if (!isLarkEditExpiredError(error)) throw error
    }
  }

  async sendButtons(
    channelId: string,
    text: string,
    buttons: InlineButton[],
    opts?: SendOptions,
  ): Promise<SentMessage> {
    const channel = this.requireChannel()
    if (buttons.length > LARK_MAX_BUTTONS) {
      this.log.warn('[lark] too many buttons; truncating', {
        event: 'lark_button_cap', requested: buttons.length, cap: LARK_MAX_BUTTONS,
      })
    }
    try {
      const result = await channel.send(
        channelId,
        { card: buildLarkCard(text, buttons) },
        toLarkSendOptions(opts),
      )
      this.cardBodies.set(result.messageId, text)
      return { platform: 'lark', channelId, messageId: result.messageId }
    } catch (error) {
      this.markCardKitDegraded(error)
      const fallback = await channel.send(
        channelId,
        { text: `${text}\n\n(Open Craft Agents to respond.)` },
        toLarkSendOptions(opts),
      )
      return { platform: 'lark', channelId, messageId: fallback.messageId }
    }
  }

  async clearButtons(
    _channelId: string,
    messageId: string,
    _opts?: SendOptions,
    resolution = '✅ Processed',
  ): Promise<void> {
    const channel = this.channel
    if (!channel) return
    const body = this.cardBodies.get(messageId) ?? ''
    try {
      await channel.updateCard(messageId, buildClearedCard(body, resolution))
    } catch (error) {
      if (!isLarkEditExpiredError(error)) {
        this.log.warn('[lark] clearButtons failed', {
          event: 'lark_clear_buttons_failed',
          messageId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  async sendTyping(_channelId: string, _opts?: SendOptions): Promise<void> {
    // CardKit's initial text is the platform-native progress indication.
  }

  async sendFile(
    channelId: string,
    file: Buffer,
    filename: string,
    caption?: string,
    opts?: SendOptions,
  ): Promise<SentMessage> {
    if (file.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`File too large (${Math.round(file.byteLength / 1024 / 1024)}MB > 20MB)`)
    }
    const channel = this.requireChannel()
    const ext = extname(filename).toLowerCase()
    const input: lark.SendInput =
      /\.(jpe?g|png|gif|webp|bmp)$/.test(ext)
        ? { image: { source: file } }
        : /\.(opus|ogg|mp3|wav|m4a)$/.test(ext)
          ? { audio: { source: file } }
          : /\.(mp4|mov|m4v|webm)$/.test(ext)
            ? { video: { source: file } }
            : { file: { source: file, fileName: filename } }
    const result = await channel.send(channelId, input, toLarkSendOptions(opts))
    if (caption) {
      await this.sendText(channelId, caption, opts).catch((error) => {
        this.log.warn('[lark] caption follow-up failed', {
          event: 'lark_caption_failed',
          messageId: result.messageId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
    return { platform: 'lark', channelId, messageId: result.messageId }
  }

  async beginNativeStream(
    channelId: string,
    initialMarkdown: string,
    opts?: SendOptions,
  ): Promise<NativeStreamHandle> {
    const channel = this.requireChannel()
    const id = randomUUID()
    const handle: NativeStreamHandle = { id }
    let resolveReady!: () => void
    let rejectReady!: (error: unknown) => void
    let resolveProducer!: () => void
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const producerDone = new Promise<void>((resolve) => {
      resolveProducer = resolve
    })
    const record: StreamRecord = {
      handle,
      ready,
      resolveReady,
      rejectReady,
      producerDone,
      resolveProducer,
      result: Promise.resolve({ messageId: '' }),
      lastMarkdown: initialMarkdown,
      channelId,
      startedAt: Date.now(),
      segmentPrefix: '',
      sendOptions: toLarkSendOptions(opts),
    }

    record.result = channel.stream(
      channelId,
      {
        markdown: async (controller) => {
          record.controller = controller
          if (!handle.messageId) handle.messageId = controller.messageId
          record.resolveReady()
          await controller.setContent(initialMarkdown)
          await record.producerDone
        },
      },
      record.sendOptions,
    ).catch((error) => {
      record.rejectReady(error)
      this.markCardKitDegraded(error)
      throw error
    })
    void record.result.catch(() => {})
    this.streams.set(id, record)

    try {
      await ready
      return handle
    } catch (error) {
      this.streams.delete(id)
      throw error
    }
  }

  async updateNativeStream(handle: NativeStreamHandle, markdown: string): Promise<void> {
    const record = this.streams.get(handle.id)
    if (!record?.controller) throw new Error('Lark stream is not available')
    if (record.lastMarkdown === markdown) return
    if (Date.now() - record.startedAt >= STREAM_MAX_DURATION_MS) {
      await this.rotateNativeStream(record, markdown)
      return
    }
    record.lastMarkdown = markdown
    await record.controller.setContent(streamSegmentMarkdown(markdown, record.segmentPrefix))
  }

  async finishNativeStream(handle: NativeStreamHandle, finalMarkdown: string): Promise<SentMessage> {
    const record = this.streams.get(handle.id)
    if (!record) throw new Error('Lark stream is not available')
    try {
      if (record.controller && record.lastMarkdown !== finalMarkdown) {
        record.lastMarkdown = finalMarkdown
        await record.controller.setContent(
          streamSegmentMarkdown(finalMarkdown, record.segmentPrefix),
        )
      }
      record.resolveProducer()
      const result = await record.result
      const messageId = handle.messageId || result.messageId || ''
      if (messageId) this.cardBodies.set(messageId, finalMarkdown)
      return { platform: 'lark', channelId: record.channelId, messageId }
    } finally {
      this.streams.delete(handle.id)
    }
  }

  async failNativeStream(handle: NativeStreamHandle, fallbackMarkdown: string): Promise<void> {
    const record = this.streams.get(handle.id)
    if (!record) return
    try {
      if (record.controller) {
        await record.controller.setContent(
          streamSegmentMarkdown(fallbackMarkdown, record.segmentPrefix),
        ).catch(() => {})
      }
    } finally {
      record.resolveProducer()
      await record.result.catch(() => {})
      this.streams.delete(handle.id)
    }
  }

  private async rotateNativeStream(record: StreamRecord, fullMarkdown: string): Promise<void> {
    record.resolveProducer()
    await record.result

    record.segmentPrefix = record.lastMarkdown
    record.startedAt = Date.now()
    record.lastMarkdown = fullMarkdown
    let resolveReady!: () => void
    let rejectReady!: (error: unknown) => void
    let resolveProducer!: () => void
    record.ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    record.producerDone = new Promise<void>((resolve) => {
      resolveProducer = resolve
    })
    record.resolveReady = resolveReady
    record.rejectReady = rejectReady
    record.resolveProducer = resolveProducer
    record.controller = undefined

    const initial = streamSegmentMarkdown(fullMarkdown, record.segmentPrefix)
    record.result = this.requireChannel().stream(
      record.channelId,
      {
        markdown: async (controller) => {
          record.controller = controller
          record.resolveReady()
          await controller.setContent(initial)
          await record.producerDone
        },
      },
      record.sendOptions,
    ).catch((error) => {
      record.rejectReady(error)
      this.markCardKitDegraded(error)
      throw error
    })
    void record.result.catch(() => {})
    await record.ready
  }

  async sendEphemeralCard(
    channelId: string,
    recipientId: string,
    markdown: string,
    buttons: InlineButton[] = [],
  ): Promise<SentMessage> {
    const channel = this.requireChannel()
    const response = await channel.rawClient.request<{
      data?: { message_id?: string }
      message_id?: string
    }>({
      url: '/open-apis/ephemeral/v1/send',
      method: 'POST',
      data: {
        open_id: recipientId,
        chat_id: channelId,
        msg_type: 'interactive',
        card: buttons.length > 0 ? buildLarkCard(markdown, buttons) : buildMarkdownCard(markdown),
      },
    })
    const data = (response as unknown as { data?: { data?: { message_id?: string }; message_id?: string } }).data
    const messageId = data?.data?.message_id ?? data?.message_id ?? ''
    this.rememberEphemeralContext(channelId, recipientId)
    return { platform: 'lark', channelId, messageId }
  }

  private async handleIncomingMessage(message: lark.NormalizedMessage): Promise<void> {
    if (!this.messageHandler) return
    const attachments: IncomingAttachment[] = []
    for (const resource of message.resources) {
      const attachment = await this.downloadResource(message.messageId, resource)
      if (attachment) attachments.push(attachment)
    }

    const attachmentOnlyMessage = ATTACHMENT_ONLY_MESSAGE_TYPES.has(message.rawContentType)

    const incoming: IncomingMessage = {
      platform: 'lark',
      channelId: message.chatId,
      messageId: message.messageId,
      senderId: message.senderId,
      senderName: message.senderName,
      text: attachments.length > 0 && attachmentOnlyMessage ? '' : message.content,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
      chatType: message.chatType === 'p2p' ? 'direct' : 'group',
      ...(message.rootId ? { rootMessageId: message.rootId } : {}),
      ...(message.threadId ? { nativeThreadId: message.threadId } : {}),
      timestamp: message.createTime || Date.now(),
      raw: message.raw ?? message,
    }
    await this.messageHandler(incoming)
  }

  private async downloadResource(
    messageId: string,
    resource: lark.ResourceDescriptor,
  ): Promise<IncomingAttachment | null> {
    const channel = this.channel
    if (!channel) return null
    try {
      const resourceType: lark.ResourceType =
        resource.type === 'image' || resource.type === 'sticker' ? 'image' : 'file'
      let file: Buffer
      let responseMimeType: string | undefined
      if (resource.type === 'sticker') {
        // Feishu's message-resource API explicitly excludes stickers; their
        // image keys continue to use the generic image endpoint.
        file = await channel.downloadResource(resource.fileKey, 'image')
        if (file.byteLength > MAX_ATTACHMENT_BYTES) {
          throw new Error(`attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`)
        }
      } else {
        // Incoming file_v3/img_v3 keys are scoped to their source message. The
        // generic files/images endpoints used by LarkChannel.downloadResource()
        // only address uploaded resources and reject these message-scoped keys.
        const response = await channel.rawClient.im.v1.messageResource.get({
          params: { type: resourceType },
          path: { message_id: messageId, file_key: resource.fileKey },
        })
        const declaredSize = Number(responseHeader(response.headers, 'content-length'))
        if (Number.isFinite(declaredSize) && declaredSize > MAX_ATTACHMENT_BYTES) {
          throw new Error(`attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`)
        }
        file = await readResourceBuffer(response.getReadableStream())
        responseMimeType = normalizeMimeType(responseHeader(response.headers, 'content-type'))
      }
      const extension = extensionForResource(resource, responseMimeType)
      const filename = resource.fileName || `${resource.type}-${randomBytes(4).toString('hex')}${extension}`
      const localPath = join(tmpdir(), `lark-${randomBytes(8).toString('hex')}${extension}`)
      writeFileSync(localPath, file)
      return {
        type: incomingType(resource),
        fileId: resource.fileKey,
        fileName: filename,
        mimeType: mimeForFilename(filename, resource.type, responseMimeType),
        fileSize: file.byteLength,
        localPath,
      }
    } catch (error) {
      this.log.warn('[lark] resource download failed', {
        event: 'lark_resource_download_failed',
        fileKey: resource.fileKey,
        resourceType: resource.type,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  private async handleCardAction(event: lark.CardActionEvent): Promise<void> {
    if (!this.buttonHandler) return
    const value = event.action.value as { buttonId?: string; data?: string } | undefined
    if (!value?.buttonId || !event.messageId || !event.chatId) {
      this.log.warn('[lark] card action missing correlation fields', {
        event: 'lark_card_action_no_ids',
        messageId: event.messageId,
        chatId: event.chatId,
      })
      return
    }
    await this.buttonHandler({
      platform: 'lark',
      channelId: event.chatId,
      messageId: event.messageId,
      senderId: event.operator.openId || event.operator.userId || '',
      senderName: event.operator.name,
      ...(this.hasEphemeralContext(
        event.chatId,
        event.operator.openId || event.operator.userId || '',
      ) ? { chatType: 'group' as const } : {}),
      buttonId: value.buttonId,
      ...(value.data !== undefined ? { data: value.data } : {}),
    })
  }

  private rememberEphemeralContext(channelId: string, recipientId: string): void {
    const now = Date.now()
    for (const [key, createdAt] of this.ephemeralContexts) {
      if (now - createdAt > EPHEMERAL_CONTEXT_TTL_MS) this.ephemeralContexts.delete(key)
    }
    while (this.ephemeralContexts.size >= MAX_EPHEMERAL_CONTEXTS) {
      const oldest = this.ephemeralContexts.keys().next().value
      if (typeof oldest !== 'string') break
      this.ephemeralContexts.delete(oldest)
    }
    this.ephemeralContexts.set(`${channelId}:${recipientId}`, now)
  }

  private hasEphemeralContext(channelId: string, recipientId: string): boolean {
    const key = `${channelId}:${recipientId}`
    const createdAt = this.ephemeralContexts.get(key)
    if (!createdAt) return false
    if (Date.now() - createdAt > EPHEMERAL_CONTEXT_TTL_MS) {
      this.ephemeralContexts.delete(key)
      return false
    }
    return true
  }

  private markCardKitDegraded(error: unknown): void {
    const code = error instanceof lark.LarkChannelError ? error.code : undefined
    if (code === 'permission_denied' || isPermissionError(error)) {
      const detail = error instanceof Error ? error.message : 'CardKit permission is missing'
      this.runtimeCallback?.('degraded', detail)
    }
  }

  private requireChannel(): lark.LarkChannel {
    if (!this.channel || !this.connected) throw new Error('Lark adapter is not connected')
    return this.channel
  }
}

function isPermissionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as {
    code?: unknown
    response?: { data?: { code?: unknown } }
  }
  const code = typeof value.code === 'number' ? value.code : value.response?.data?.code
  return code === 99991672 || code === 230006 || code === 300311
}
