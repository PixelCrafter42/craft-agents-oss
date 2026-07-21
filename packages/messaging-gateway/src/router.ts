/**
 * Router — routes inbound messages from platform adapters to sessions.
 *
 * Looks up the ChannelBinding for (platform, channelId).
 * If found → access-control gate, then resolves any `IncomingAttachment.localPath`
 * entries to `FileAttachment`s via `readFileAttachment()` and forwards to
 * SessionManager.
 * If not found → delegates to Commands for /bind, /new, etc. (Commands
 * applies its own pre-binding access gate.)
 */

import type { ISessionManager } from '@craft-agent/server-core/handlers'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { readFileAttachment } from '@craft-agent/shared/utils'
import type { FileAttachment } from '@craft-agent/shared/protocol'
import {
  evaluateBindingAccess,
  executeRejection,
  type AccessRejectReason,
} from './access-control'
import type { BindingStore } from './binding-store'
import type { Commands } from './commands'
import type { PendingSendersStore } from './pending-senders'
import type {
  IncomingMessage,
  IncomingAttachment,
  MessagingConfig,
  MessagingLogger,
  PlatformAdapter,
} from './types'

const NOOP_LOGGER: MessagingLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
}

const MAX_ROUTED_ATTACHMENT_BYTES = 20 * 1024 * 1024
const MESSAGING_ORIGIN_TTL_MS = 30 * 60 * 1000
const MAX_MESSAGING_ORIGINS = 512

export interface MessagingOriginContext {
  id: string
  bindingId: string
  platform: IncomingMessage['platform']
  channelId: string
  messageId: string
  senderId: string
  chatType?: IncomingMessage['chatType']
  rootMessageId?: string
  nativeThreadId?: string
  createdAt: number
}

const MIME_EXT_FALLBACK: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
  'application/pdf': '.pdf',
}

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tiff',
  '.tif',
  '.heic',
  '.heif',
  '.svg',
  '.ico',
])

export interface RouterDeps {
  /** Reads the workspace's current MessagingConfig. Called per-message
   *  so config edits take effect without restart. */
  getWorkspaceConfig: () => MessagingConfig
  /** Optional pending-senders store; rejected attempts are recorded here so
   *  the Settings UI can surface them with one-click "Allow" buttons. */
  pendingStore?: PendingSendersStore
}

function normalizeMimeType(mimeType?: string): string | undefined {
  const normalized = mimeType?.split(';', 1)[0]?.trim().toLowerCase()
  return normalized || undefined
}

function detectImageMimeFromMagic(buffer: Buffer): { mimeType: string; ext: string } | undefined {
  if (buffer.byteLength >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg', ext: '.jpg' }
  }
  if (
    buffer.byteLength >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mimeType: 'image/png', ext: '.png' }
  }
  const ascii6 = buffer.subarray(0, 6).toString('ascii')
  if (ascii6 === 'GIF87a' || ascii6 === 'GIF89a') {
    return { mimeType: 'image/gif', ext: '.gif' }
  }
  if (
    buffer.byteLength >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mimeType: 'image/webp', ext: '.webp' }
  }
  if (buffer.byteLength >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return { mimeType: 'image/bmp', ext: '.bmp' }
  }
  if (
    buffer.byteLength >= 4 &&
    ((buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
      (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a))
  ) {
    return { mimeType: 'image/tiff', ext: '.tiff' }
  }
  if (buffer.byteLength >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii')
    if (brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'hevx') {
      return { mimeType: 'image/heic', ext: '.heic' }
    }
    if (brand === 'mif1' || brand === 'msf1') {
      return { mimeType: 'image/heif', ext: '.heif' }
    }
  }
  return undefined
}

function nameWithExtension(name: string, ext: string): string {
  const fallbackName = name.trim() || `attachment${ext}`
  const currentExt = extname(fallbackName).toLowerCase()
  if (!currentExt) return `${fallbackName}${ext}`
  if (currentExt === '.bin' || (IMAGE_EXTENSIONS.has(ext) && !IMAGE_EXTENSIONS.has(currentExt))) {
    return `${fallbackName.slice(0, -currentExt.length)}${ext}`
  }
  return fallbackName
}

function buildImageAttachmentFromLocalPath(a: IncomingAttachment): FileAttachment | null {
  if (!a.localPath || !existsSync(a.localPath)) return null

  const stats = statSync(a.localPath)
  if (!stats.isFile()) return null
  if (stats.size > MAX_ROUTED_ATTACHMENT_BYTES) {
    throw new Error(`File too large: ${basename(a.localPath)} (${Math.round(stats.size / 1024 / 1024)}MB > 20MB limit)`)
  }

  const buffer = readFileSync(a.localPath)
  const detected = detectImageMimeFromMagic(buffer)
  const metadataMime = normalizeMimeType(a.mimeType)
  const imageMimeType =
    detected?.mimeType ??
    (metadataMime?.startsWith('image/') ? metadataMime : undefined) ??
    (a.type === 'photo' ? 'image/jpeg' : undefined)

  if (!imageMimeType) return null

  const ext = detected?.ext ?? MIME_EXT_FALLBACK[imageMimeType] ?? '.jpg'
  const sourceName = a.fileName || basename(a.localPath)
  return {
    type: 'image',
    path: a.localPath,
    name: nameWithExtension(sourceName, ext),
    mimeType: imageMimeType,
    size: stats.size,
    base64: buffer.toString('base64'),
  }
}

export class Router {
  private readonly deps: RouterDeps
  private readonly recentRejectReplies = new Map<string, number>()
  private readonly messagingOrigins = new Map<string, MessagingOriginContext>()

  constructor(
    private readonly sessionManager: ISessionManager,
    private readonly bindingStore: BindingStore,
    private readonly commands: Commands,
    private readonly log: MessagingLogger = NOOP_LOGGER,
    deps: RouterDeps = { getWorkspaceConfig: () => ({ enabled: false, platforms: {} }) },
  ) {
    this.deps = deps
  }

  async route(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    // Threads (Telegram supergroup forum topics) participate in the binding
    // lookup key, so two topics in the same supergroup route to different
    // sessions even though they share `chat.id`.
    const binding = this.bindingStore.findByChannel(msg.platform, msg.channelId, msg.threadId)

    if (binding) {
      const verdict = evaluateBindingAccess({
        msg,
        workspaceConfig: this.deps.getWorkspaceConfig(),
        binding,
      })
      if (!verdict.allow) {
        await this.handleReject(adapter, msg, verdict.reason, {
          bindingId: binding.id,
          sessionId: binding.sessionId,
        })
        return
      }

      try {
        const fileAttachments = this.resolveAttachments(msg)
        const messagingOriginId = randomUUID()
        this.rememberMessagingOrigin({
          id: messagingOriginId,
          bindingId: binding.id,
          platform: msg.platform,
          channelId: msg.channelId,
          messageId: msg.messageId,
          senderId: msg.senderId,
          chatType: msg.chatType,
          rootMessageId: msg.rootMessageId,
          nativeThreadId: msg.nativeThreadId,
          createdAt: Date.now(),
        })
        this.log.info('routing inbound chat message to session', {
          event: 'message_routed',
          platform: msg.platform,
          channelId: msg.channelId,
          threadId: msg.threadId,
          sessionId: binding.sessionId,
          bindingId: binding.id,
          attachmentCount: fileAttachments?.length ?? 0,
        })
        await this.sessionManager.sendMessage(
          binding.sessionId,
          msg.text,
          fileAttachments,
          undefined, // storedAttachments (handled by session layer)
          { messagingOriginId },
        )
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error'
        this.log.error('failed to route inbound chat message', {
          event: 'message_route_failed',
          platform: msg.platform,
          channelId: msg.channelId,
          threadId: msg.threadId,
          sessionId: binding.sessionId,
          bindingId: binding.id,
          error: err,
        })
        await adapter.sendText(
          msg.channelId,
          `Failed to send message to session: ${errorMsg}`,
          {
            ...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
            ...(msg.platform === 'lark' ? { replyToMessageId: msg.messageId } : {}),
            ...(msg.platform === 'lark' && msg.nativeThreadId ? { replyInThread: true } : {}),
            ...(msg.ephemeralReply ? { ephemeral: msg.ephemeralReply } : {}),
          },
        )
      }
      return
    }

    this.log.info('routing inbound chat message to command handler', {
      event: 'message_unbound',
      platform: msg.platform,
      channelId: msg.channelId,
      threadId: msg.threadId,
      messageId: msg.messageId,
    })
    await this.commands.handle(adapter, msg)
  }

  getMessagingOrigin(id: string | undefined): MessagingOriginContext | undefined {
    if (!id) return undefined
    const origin = this.messagingOrigins.get(id)
    if (!origin) return undefined
    if (Date.now() - origin.createdAt > MESSAGING_ORIGIN_TTL_MS) {
      this.messagingOrigins.delete(id)
      return undefined
    }
    return origin
  }

  releaseMessagingOrigin(id: string | undefined): void {
    if (id) this.messagingOrigins.delete(id)
  }

  private rememberMessagingOrigin(origin: MessagingOriginContext): void {
    const now = Date.now()
    for (const [id, existing] of this.messagingOrigins) {
      if (now - existing.createdAt > MESSAGING_ORIGIN_TTL_MS) {
        this.messagingOrigins.delete(id)
      }
    }
    while (this.messagingOrigins.size >= MAX_MESSAGING_ORIGINS) {
      const oldest = this.messagingOrigins.keys().next().value
      if (typeof oldest !== 'string') break
      this.messagingOrigins.delete(oldest)
    }
    this.messagingOrigins.set(origin.id, origin)
  }

  /**
   * Common reject path for both bound (this file) and pre-binding (Commands)
   * gating. Delegates to the shared `executeRejection` so text and button
   * paths behave identically.
   */
  async handleReject(
    adapter: PlatformAdapter,
    msg: IncomingMessage,
    reason: AccessRejectReason,
    extra?: { bindingId?: string; sessionId?: string },
  ): Promise<void> {
    await executeRejection(
      adapter,
      msg,
      reason,
      {
        recentRejectReplies: this.recentRejectReplies,
        ...(this.deps.pendingStore ? { pendingStore: this.deps.pendingStore } : {}),
      },
      this.log,
      extra,
    )
  }

  /**
   * Convert adapter-emitted `IncomingAttachment[]` into the session's
   * `FileAttachment[]` shape. Adapters that download the blob to disk
   * populate `localPath`; we wrap it with `readFileAttachment()` which
   * handles image→base64 / pdf→base64 / text→utf-8 encoding.
   *
   * Attachments without a `localPath`, or whose file can't be read, are
   * silently skipped — the upstream adapter already logged/notified on
   * download failure, so re-surfacing here would double up.
   */
  private resolveAttachments(msg: IncomingMessage): FileAttachment[] | undefined {
    if (!msg.attachments?.length) return undefined
    const built: FileAttachment[] = []
    for (const a of msg.attachments) {
      if (!a.localPath) continue
      const imageAttachment = buildImageAttachmentFromLocalPath(a)
      const att = imageAttachment ?? (readFileAttachment(a.localPath) as FileAttachment | null)
      if (!att) continue
      if (!imageAttachment && a.fileName) att.name = a.fileName
      built.push(att)
    }
    return built.length > 0 ? built : undefined
  }
}
