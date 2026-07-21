/**
 * TelegramAdapter — in-process adapter using grammY.
 *
 * Phase 1: polling mode, text-only, DM-only.
 */

import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Bot, InputFile, type Context } from 'grammy'
import type {
  PlatformAdapter,
  PlatformConfig,
  AdapterCapabilities,
  IncomingAttachment,
  IncomingMessage,
  SendOptions,
  SentMessage,
  InlineButton,
  InlineButtonRow,
  ButtonPress,
  MessagingLogger,
  PlatformCommand,
  CommandMenuOptions,
  EphemeralMessageReference,
  EphemeralReplyTarget,
} from '../../types'
import { formatForTelegram, formatPlainTextForTelegram } from './format'
import {
  buildTelegramRichMediaMessage,
  buildTelegramRichMessage,
  type TelegramInputMedia,
  type TelegramRichMessagePayload,
} from './rich-message'

/**
 * Discriminated chat metadata returned by `getChatInfo`. Phase A's supergroup
 * pairing flow uses this to validate that the user typed `/pair` in an
 * actual forum supergroup before binding it as the workspace's supergroup.
 */
export type TelegramChatInfo =
  | { type: 'supergroup'; isForum: boolean; title: string }
  | { type: 'group' | 'channel' | 'private'; title?: string }

/**
 * Hard cap for downloaded attachment size. Matches `MAX_FILE_SIZE` in
 * `@craft-agent/shared/utils/files` — files larger than this would be
 * rejected by `readFileAttachment` anyway, so we fail fast in the adapter
 * with a user-visible reply instead of silently dropping.
 */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
const TELEGRAM_DRAFT_TEXT_LIMIT = 4096
const TELEGRAM_PARSE_MODE = 'MarkdownV2' as const
const TELEGRAM_VOICE_EXTENSIONS = new Set(['.ogg', '.oga', '.opus', '.mp3', '.m4a'])
const TELEGRAM_AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a'])
const TELEGRAM_ANIMATION_EXTENSIONS = new Set(['.gif'])
const TELEGRAM_PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.heic', '.heif'])
const TELEGRAM_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm'])
const TELEGRAM_COMMAND_NAME_RE = /^[a-z0-9_]{1,32}$/

const TELEGRAM_BASE_COMMAND_MENU: PlatformCommand[] = [
  { command: 'menu', description: 'Open the interactive menu' },
  { command: 'pair', description: 'Redeem a pairing code' },
]

type TelegramCommandScope =
  | { type: 'default' }
  | { type: 'all_private_chats' }
  | { type: 'all_group_chats' }
  | { type: 'all_chat_administrators' }
  | { type: 'chat'; chat_id: number | string }

interface TelegramCommandMenuTarget {
  label: string
  scope: TelegramCommandScope
  isEphemeral: boolean
}

/**
 * Minimal mime → extension fallback used when Telegram's `file_path` is
 * missing or extension-less. Kept intentionally small — anything unknown
 * becomes `.bin` and `readFileAttachment` will classify it as 'unknown'.
 */
const MIME_EXT_FALLBACK: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'application/pdf': '.pdf',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
}

const NOOP_LOGGER: MessagingLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
}

type FetchInput = Parameters<typeof globalThis.fetch>[0]
type FetchInit = Parameters<typeof globalThis.fetch>[1]
type NativeFetchInit = NonNullable<FetchInit> & { duplex?: 'half' }

interface TelegramSendRichMessagePayload {
  chat_id: number | string
  rich_message: TelegramRichMessagePayload
  message_thread_id?: number
}

interface TelegramSendRichMessageDraftPayload {
  chat_id: number
  draft_id: number
  rich_message: TelegramRichMessagePayload
  message_thread_id?: number
}

interface TelegramRawRichApi {
  sendRichMessage(payload: TelegramSendRichMessagePayload): Promise<TelegramMessageResult>
  sendRichMessageDraft(payload: TelegramSendRichMessageDraftPayload): Promise<true>
}

interface TelegramMessageResult {
  message_id: number
  ephemeral_message_id?: number
  receiver_user?: { id: number }
}

interface TelegramSendMessagePayload {
  chat_id: number | string
  text: string
  parse_mode: typeof TELEGRAM_PARSE_MODE
  message_thread_id?: number
  receiver_user_id: number
  callback_query_id?: string
  reply_parameters?: { ephemeral_message_id: number }
  reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }
}

interface TelegramRawEphemeralApi {
  sendMessage(payload: TelegramSendMessagePayload): Promise<TelegramMessageResult>
  editEphemeralMessageText(payload: {
    chat_id: number | string
    receiver_user_id: number
    ephemeral_message_id: number
    text: string
    parse_mode: typeof TELEGRAM_PARSE_MODE
  }): Promise<true>
  editEphemeralMessageReplyMarkup(payload: {
    chat_id: number | string
    receiver_user_id: number
    ephemeral_message_id: number
    reply_markup: { inline_keyboard: [] }
  }): Promise<true>
  deleteEphemeralMessage(payload: {
    chat_id: number | string
    receiver_user_id: number
    ephemeral_message_id: number
  }): Promise<true>
}

type TelegramRawApi = TelegramRawRichApi & TelegramRawEphemeralApi

function telegramFetch(input: FetchInput, init?: FetchInit): Promise<Response> {
  const body = init?.body
  const needsDuplex =
    body != null &&
    typeof body !== 'string' &&
    !(body instanceof URLSearchParams) &&
    !(body instanceof FormData) &&
    !(body instanceof Blob) &&
    !(body instanceof ArrayBuffer)
  const nextInit = needsDuplex
    ? ({ ...init, duplex: 'half' } as NativeFetchInit)
    : init
  return globalThis.fetch(input, nextInit)
}

/**
 * Race a promise against a timeout. If `ms` elapses before `p` settles, reject
 * with a labelled error. Used to surface grammY's silent-retry hangs on
 * `bot.init()` / `deleteWebhook()` as real, actionable errors.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`[telegram] ${label} timed out after ${ms}ms`)),
      ms,
    )
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/**
 * Unwrap an error for structured logging. grammY's HttpError wraps the real
 * fetch/undici cause in an `.error` field; electron-log's JSON serializer
 * otherwise sees an empty object because Error's own fields are non-enumerable.
 * Walks up to 3 levels of wrapping (HttpError -> cause -> cause).
 */
function describeError(err: unknown, depth = 0): Record<string, unknown> {
  if (depth > 3) return { truncated: true }
  if (err instanceof Error) {
    const out: Record<string, unknown> = {
      name: err.name,
      message: err.message,
    }
    const code = (err as { code?: unknown }).code
    if (code !== undefined) out.code = code
    const grammyInner = (err as { error?: unknown }).error
    if (grammyInner !== undefined) out.error = describeError(grammyInner, depth + 1)
    const cause = (err as { cause?: unknown }).cause
    if (cause !== undefined) out.cause = describeError(cause, depth + 1)
    if (err.stack) out.stack = err.stack.split('\n').slice(0, 4).join('\n')
    return out
  }
  if (err && typeof err === 'object') return { value: String(err), raw: err as object }
  return { value: String(err) }
}

function isEntityParseError(err: unknown): boolean {
  const description = err && typeof err === 'object'
    ? String((err as { description?: unknown }).description ?? '')
    : ''
  const message = err instanceof Error ? err.message : String(err)
  return /can't parse entities|entity/i.test(description || message)
}

function sendTextOptions(opts?: SendOptions): { parse_mode: typeof TELEGRAM_PARSE_MODE; message_thread_id?: number } {
  return { parse_mode: TELEGRAM_PARSE_MODE, ...threadParams(opts) }
}

function sendCaptionOptions(
  caption: string | undefined,
  opts?: SendOptions,
): { caption?: string; parse_mode?: typeof TELEGRAM_PARSE_MODE; message_thread_id?: number } {
  const formattedCaption = caption ? formatForTelegram(caption) : undefined
  return {
    ...(formattedCaption ? { caption: formattedCaption, parse_mode: TELEGRAM_PARSE_MODE } : {}),
    ...threadParams(opts),
  }
}

function isTelegramVoiceFile(filename: string): boolean {
  return TELEGRAM_VOICE_EXTENSIONS.has(extname(filename).toLowerCase())
}

function isTelegramAudioFile(filename: string): boolean {
  return TELEGRAM_AUDIO_EXTENSIONS.has(extname(filename).toLowerCase())
}

function richMediaKind(filename: string): TelegramInputMedia['type'] | null {
  const extension = extname(filename).toLowerCase()
  if (TELEGRAM_ANIMATION_EXTENSIONS.has(extension)) return 'animation'
  if (TELEGRAM_PHOTO_EXTENSIONS.has(extension)) return 'photo'
  if (TELEGRAM_VIDEO_EXTENSIONS.has(extension)) return 'video'
  if (TELEGRAM_VOICE_EXTENSIONS.has(extension)) return isTelegramAudioFile(filename) ? 'audio' : 'voice_note'
  return null
}

function truncateDraftText(text: string): string {
  if (text.length <= TELEGRAM_DRAFT_TEXT_LIMIT) return text
  return `${text.slice(0, TELEGRAM_DRAFT_TEXT_LIMIT - 4)} ...`
}

function telegramChatId(channelId: string): number | string {
  const numeric = Number(channelId)
  return Number.isFinite(numeric) && channelId.trim() !== '' ? numeric : channelId
}

function telegramRawApi(bot: Bot): TelegramRawApi {
  return (bot.api as unknown as { raw: TelegramRawApi }).raw
}

function numericTelegramId(value: string, label: string): number {
  const numeric = Number(value)
  if (!Number.isSafeInteger(numeric)) throw new Error(`Invalid Telegram ${label}: ${value}`)
  return numeric
}

function ephemeralParams(target: EphemeralReplyTarget): Pick<
  TelegramSendMessagePayload,
  'receiver_user_id' | 'callback_query_id' | 'reply_parameters'
> {
  return {
    receiver_user_id: numericTelegramId(target.recipientId, 'recipient id'),
    ...(target.interactionId ? { callback_query_id: target.interactionId } : {}),
    ...(target.sourceMessageId
      ? { reply_parameters: { ephemeral_message_id: numericTelegramId(target.sourceMessageId, 'ephemeral message id') } }
      : {}),
  }
}

function sentMessageResult(
  channelId: string,
  sent: TelegramMessageResult,
  target?: EphemeralReplyTarget,
): SentMessage {
  const ephemeralId = sent.ephemeral_message_id
  return {
    platform: 'telegram',
    channelId,
    messageId: String(ephemeralId ?? sent.message_id),
    ...(ephemeralId !== undefined && target
      ? { ephemeral: { recipientId: target.recipientId, messageId: String(ephemeralId) } }
      : {}),
  }
}

function normalizeCommandMenu(commands: PlatformCommand[]): PlatformCommand[] {
  const seen = new Set<string>()
  const out: PlatformCommand[] = []
  for (const command of commands) {
    const name = command.command.trim().replace(/^\//, '').toLowerCase()
    const description = command.description.trim().slice(0, 256)
    if (!TELEGRAM_COMMAND_NAME_RE.test(name) || !description || seen.has(name)) continue
    seen.add(name)
    out.push({ command: name, description })
    if (out.length >= 100) break
  }
  return out
}

function commandMenuTargets(opts?: CommandMenuOptions): TelegramCommandMenuTarget[] {
  if (opts?.channelId) {
    return [{
      label: 'chat',
      scope: { type: 'chat', chat_id: telegramChatId(opts.channelId) },
      isEphemeral: opts.ephemeral === true,
    }]
  }

  return [
    { label: 'default', scope: { type: 'default' }, isEphemeral: false },
    { label: 'all_private_chats', scope: { type: 'all_private_chats' }, isEphemeral: false },
    { label: 'all_group_chats', scope: { type: 'all_group_chats' }, isEphemeral: true },
    { label: 'all_chat_administrators', scope: { type: 'all_chat_administrators' }, isEphemeral: true },
  ]
}

/**
 * DM-only guard. Retained because tests use it directly; new code paths
 * should call `isAcceptedChat()` which also accepts the workspace's
 * configured supergroup chat (forum).
 */
export function isPrivateChat(ctx: Context): boolean {
  return ctx.chat?.type === 'private'
}

/** Translate Bot API 10.2 message fields without leaking their names upstream. */
export function telegramEphemeralReplyTarget(ctx: Context): EphemeralReplyTarget | undefined {
  if (ctx.chat?.type !== 'group' && ctx.chat?.type !== 'supergroup') return undefined
  if (!ctx.from?.id) return undefined
  const message = ctx.message as (typeof ctx.message & { ephemeral_message_id?: number }) | undefined
  const sourceMessageId = message?.ephemeral_message_id
  return {
    recipientId: String(ctx.from.id),
    ...(sourceMessageId !== undefined ? { sourceMessageId: String(sourceMessageId) } : {}),
    ...(sourceMessageId !== undefined && message?.date
      ? { expiresAt: message.date * 1000 + 15_000 }
      : {}),
  }
}

interface TelegramCallbackEphemeralContext {
  reply?: EphemeralReplyTarget
  source?: EphemeralMessageReference
}

/** Translate callback_query_id plus receiver_user/ephemeral_message_id. */
export function telegramCallbackEphemeralContext(
  ctx: Context,
  receivedAt = Date.now(),
): TelegramCallbackEphemeralContext {
  const callbackMessage = ctx.callbackQuery?.message as
    | (NonNullable<typeof ctx.callbackQuery>['message'] & {
        ephemeral_message_id?: number
        receiver_user?: { id: number }
      })
    | undefined
  const recipientId = String(ctx.from?.id ?? '')
  const ephemeralMessageId = callbackMessage?.ephemeral_message_id
  const sourceRecipientId = String(callbackMessage?.receiver_user?.id ?? ctx.from?.id ?? '')
  return {
    ...((ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') && recipientId && ctx.callbackQuery?.id
      ? {
          reply: {
            recipientId,
            interactionId: ctx.callbackQuery.id,
            expiresAt: receivedAt + 15_000,
          },
        }
      : {}),
    ...(ephemeralMessageId !== undefined && sourceRecipientId
      ? { source: { recipientId: sourceRecipientId, messageId: String(ephemeralMessageId) } }
      : {}),
  }
}

/**
 * Decide whether an inbound update should be processed.
 *
 * - DMs (`private` chats) are always accepted — same as Phase 1.
 * - When the workspace has a paired supergroup, that exact `chat.id` is
 *   also accepted (forum topics live inside it).
 * - Everything else (other groups, channels, basic groups the bot was
 *   added to without explicit configuration) is dropped.
 *
 * Sender-level authorization for groups/topics is intentionally NOT enforced
 * here — pairing the supergroup in Settings is the per-workspace consent
 * boundary, and topic-scoped bindings determine which session each topic
 * routes to.
 */
export function isAcceptedChat(ctx: Context, supergroupChatId?: string): boolean {
  const chat = ctx.chat
  if (!chat) return false
  if (chat.type === 'private') return true
  if (!supergroupChatId) return false
  return String(chat.id) === supergroupChatId
}

export class TelegramAdapter implements PlatformAdapter {
  readonly platform = 'telegram' as const
  readonly capabilities: AdapterCapabilities = {
    messageEditing: true,
    inlineButtons: true,
    ephemeralMessages: true,
    messageDrafts: true,
    richMessages: true,
    richMessageDrafts: true,
    maxButtons: 10,
    maxMessageLength: 4096,
    markdown: 'v2',
    // This adapter uses polling (grammY Bot#start). A webhook path is not
    // wired through the Electron main process, so advertising webhookSupport
    // would mislead the headless server bootstrap. Keep false until a proper
    // webhook handler exists.
    webhookSupport: false,
  }

  /** Fetch bot profile (username, display name). Used for UI hints. */
  async getBotInfo(): Promise<{ id: number; username?: string; firstName?: string } | null> {
    if (!this.bot) return null
    try {
      const me = await this.bot.api.getMe()
      return { id: me.id, username: me.username, firstName: me.first_name }
    } catch {
      return null
    }
  }

  private bot: Bot | null = null
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null
  private buttonHandler: ((press: ButtonPress) => Promise<void>) | null = null
  private connected = false
  private destroyed = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private log: MessagingLogger = NOOP_LOGGER
  /**
   * The supergroup chatId this adapter accepts non-DM messages from.
   * Updated at runtime via `setAcceptedSupergroupChatId()` after the user
   * pairs/unpairs a supergroup in Settings, so polling doesn't need to
   * restart on reconfigure.
   */
  private supergroupChatId: string | undefined

  /**
   * Emit one structured log line per dropped non-accepted update. Deliberately
   * `info` (not `debug`) so a user who notices "bot isn't responding in my
   * group" can confirm via logs without toggling levels.
   */
  private logRejectedChat(handler: string, ctx: Context): void {
    this.log.info('[telegram] ignored non-accepted chat update', {
      event: 'telegram_chat_rejected',
      handler,
      chatType: ctx.chat?.type,
      chatId: ctx.chat?.id,
    })
  }

  /** Idempotent runtime reconfigure for the accepted supergroup chatId. */
  setAcceptedSupergroupChatId(chatId: string | undefined): void {
    this.supergroupChatId = chatId
    this.log.info('[telegram] accepted supergroup updated', {
      event: 'telegram_supergroup_set',
      supergroupChatId: chatId ?? null,
    })
  }

  /**
   * Resolve a chat's metadata via Bot API. Returns `null` on any failure
   * (network, "chat not found", missing permissions, etc.). The caller is
   * expected to handle the null case explicitly — for the supergroup-pairing
   * flow that means refusing to bind, rather than guessing defaults.
   *
   * Forum supergroups are the only chat type that can host topics. The
   * `isForum` flag distinguishes a regular supergroup from one with topics
   * enabled, which is required for Phase B's `createForumTopic` to work.
   */
  async getChatInfo(chatId: string): Promise<TelegramChatInfo | null> {
    if (!this.bot) return null
    try {
      const chat = await this.bot.api.getChat(Number(chatId))
      if (chat.type === 'supergroup') {
        return {
          type: 'supergroup',
          isForum: Boolean((chat as { is_forum?: boolean }).is_forum),
          title: chat.title ?? `Group ${chatId}`,
        }
      }
      return {
        type: chat.type,
        title: 'title' in chat && typeof chat.title === 'string' ? chat.title : undefined,
      }
    } catch {
      return null
    }
  }

  /**
   * Telegram-specific helper: extract the optional `message_thread_id` from
   * an inbound update. Returns undefined for DMs and for the General topic
   * (Telegram omits the field there).
   */
  private extractThreadId(ctx: Context): number | undefined {
    const tid = ctx.message?.message_thread_id
    return typeof tid === 'number' ? tid : undefined
  }

  async initialize(config: PlatformConfig): Promise<void> {
    if (!config.token) {
      throw new Error('Telegram bot token is required')
    }

    this.log = config.logger ?? NOOP_LOGGER
    this.bot = new Bot(config.token, {
      client: {
        fetch: telegramFetch,
      },
    })
    if (config.acceptedSupergroupChatId) {
      this.supergroupChatId = config.acceptedSupergroupChatId
    }

    // Handle incoming text messages.
    //
    // Narrow exception to `isAcceptedChat`: `/pair <code>` is allowed from
    // *any* chat, even if the workspace hasn't paired this chat yet. This is
    // the bootstrap mechanism that registers a supergroup — without this
    // exception, `/pair` typed in a fresh supergroup is silently dropped
    // (chicken-and-egg). Codes are workspace-scoped, single-use, 5-min TTL,
    // and rate-limited per-sender, so the exception is bounded.
    this.bot.on('message:text', async (ctx: Context) => {
      if (!this.messageHandler || !ctx.message || !ctx.chat) return
      const text = ctx.message.text ?? ''
      const isPairAttempt = /^\/pair(\s|$|@)/i.test(text)
      if (!isAcceptedChat(ctx, this.supergroupChatId) && !isPairAttempt) {
        this.logRejectedChat('message:text', ctx)
        return
      }

      const threadId = this.extractThreadId(ctx)
      const ephemeralReply = telegramEphemeralReplyTarget(ctx)
      const msg: IncomingMessage = {
        platform: 'telegram',
        channelId: String(ctx.chat.id),
        ...(threadId !== undefined ? { threadId } : {}),
        messageId: String(ctx.message.message_id),
        senderId: String(ctx.from?.id ?? ''),
        senderName: ctx.from?.first_name ?? undefined,
        ...(ctx.from?.username ? { senderUsername: ctx.from.username } : {}),
        ...(ctx.from?.is_bot ? { senderIsBot: true } : {}),
        ...(ephemeralReply ? { ephemeralReply } : {}),
        text: ctx.message.text ?? '',
        timestamp: ctx.message.date * 1000,
        raw: ctx.message,
      }

      await this.messageHandler(msg)
    })

    // Attachment handlers — photos, documents, voice, video, audio.
    // Each maps Telegram's source field onto a single helper that
    // downloads the blob to a temp file, then emits one IncomingMessage
    // with `attachments[0].localPath` set. The router resolves the path
    // via readFileAttachment() and forwards a FileAttachment to the session.
    this.bot.on('message:photo', async (ctx: Context) => {
      if (!isAcceptedChat(ctx, this.supergroupChatId)) {
        this.logRejectedChat('message:photo', ctx)
        return
      }
      const photos = ctx.message?.photo
      // Telegram returns multiple sizes; last one is the largest original.
      const largest = photos?.[photos.length - 1]
      if (!largest) return
      await this.emitAttachmentMessage(ctx, {
        type: 'photo',
        fileId: largest.file_id,
        fileSize: largest.file_size,
        mimeType: 'image/jpeg', // Telegram re-encodes photos to JPEG
      })
    })

    this.bot.on('message:document', async (ctx: Context) => {
      if (!isAcceptedChat(ctx, this.supergroupChatId)) {
        this.logRejectedChat('message:document', ctx)
        return
      }
      const doc = ctx.message?.document
      if (!doc) return
      await this.emitAttachmentMessage(ctx, {
        type: 'document',
        fileId: doc.file_id,
        fileName: doc.file_name,
        fileSize: doc.file_size,
        mimeType: doc.mime_type,
      })
    })

    this.bot.on('message:voice', async (ctx: Context) => {
      if (!isAcceptedChat(ctx, this.supergroupChatId)) {
        this.logRejectedChat('message:voice', ctx)
        return
      }
      const voice = ctx.message?.voice
      if (!voice) return
      await this.emitAttachmentMessage(ctx, {
        type: 'voice',
        fileId: voice.file_id,
        fileSize: voice.file_size,
        mimeType: voice.mime_type ?? 'audio/ogg',
      })
    })

    this.bot.on('message:video', async (ctx: Context) => {
      if (!isAcceptedChat(ctx, this.supergroupChatId)) {
        this.logRejectedChat('message:video', ctx)
        return
      }
      const video = ctx.message?.video
      if (!video) return
      await this.emitAttachmentMessage(ctx, {
        type: 'video',
        fileId: video.file_id,
        fileName: video.file_name,
        fileSize: video.file_size,
        mimeType: video.mime_type ?? 'video/mp4',
      })
    })

    this.bot.on('message:audio', async (ctx: Context) => {
      if (!isAcceptedChat(ctx, this.supergroupChatId)) {
        this.logRejectedChat('message:audio', ctx)
        return
      }
      const audio = ctx.message?.audio
      if (!audio) return
      await this.emitAttachmentMessage(ctx, {
        type: 'audio',
        fileId: audio.file_id,
        fileName: audio.file_name,
        fileSize: audio.file_size,
        mimeType: audio.mime_type ?? 'audio/mpeg',
      })
    })

    // Handle callback queries (button presses)
    this.bot.on('callback_query:data', async (ctx: Context) => {
      if (!this.buttonHandler || !ctx.callbackQuery) return
      const receivedAt = Date.now()
      if (!isAcceptedChat(ctx, this.supergroupChatId)) {
        this.logRejectedChat('callback_query:data', ctx)
        // Answer the callback so Telegram stops showing the spinner, but
        // don't route it — same rationale as message handlers.
        await ctx.answerCallbackQuery().catch(() => {})
        return
      }

      await ctx.answerCallbackQuery().catch(() => {})

      // The button is attached to a message; reading the message's thread id
      // ensures responses (allow/deny acks, plan accept confirmations) post
      // back into the same topic the prompt came from.
      const threadId = typeof ctx.callbackQuery.message?.message_thread_id === 'number'
        ? ctx.callbackQuery.message.message_thread_id
        : undefined
      const ephemeral = telegramCallbackEphemeralContext(ctx, receivedAt)

      const press: ButtonPress = {
        platform: 'telegram',
        channelId: String(ctx.chat?.id ?? ''),
        ...(threadId !== undefined ? { threadId } : {}),
        messageId: String(ctx.callbackQuery.message?.message_id ?? ''),
        senderId: String(ctx.from?.id ?? ''),
        ...(ctx.from?.first_name ? { senderName: ctx.from.first_name } : {}),
        ...(ctx.from?.username ? { senderUsername: ctx.from.username } : {}),
        ...(ctx.from?.is_bot ? { senderIsBot: true } : {}),
        ...(ephemeral.reply ? { ephemeralReply: ephemeral.reply } : {}),
        ...(ephemeral.source ? { sourceEphemeral: ephemeral.source } : {}),
        buttonId: ctx.callbackQuery.data ?? '',
        data: ctx.callbackQuery.data ?? undefined,
      }

      // Diagnostic for #726: timestamp callback receipt vs. handler return so
      // we can tell from logs whether the gateway is slow or grammY's
      // sequential polling is stalling on a previous update.
      this.log.info('[telegram] callback_query received', {
        event: 'telegram_callback_received',
        buttonId: press.buttonId,
        senderId: press.senderId,
      })
      try {
        await this.buttonHandler(press)
      } finally {
        this.log.info('[telegram] callback_query handler returned', {
          event: 'telegram_callback_handled',
          buttonId: press.buttonId,
          senderId: press.senderId,
          elapsedMs: Date.now() - receivedAt,
        })
      }
    })

    this.log.info('[telegram] initializing')

    // Clear any pre-existing webhook BEFORE bot.init(). grammY's Api client
    // works without init() (which only caches getMe), and if a webhook is set
    // (by a previous app run, another app, or BotFather), getUpdates returns
    // nothing and polling silently receives no messages. Doing this first
    // means even a slow/stuck init() can't prevent webhook cleanup.
    // drop_pending_updates=false preserves messages queued before the user
    // saved the token.
    try {
      await withTimeout(
        this.bot.api.deleteWebhook({ drop_pending_updates: false }),
        10_000,
        'deleteWebhook',
      )
      this.log.info('[telegram] deleteWebhook ok')
    } catch (err) {
      this.log.warn('[telegram] deleteWebhook failed (non-fatal):', describeError(err))
    }

    // Surface token/network errors up-front (getMe). Without the timeout,
    // grammY retries transient errors indefinitely with no logs, which looks
    // identical to a deadlock from the outside.
    try {
      await withTimeout(this.bot.init(), 10_000, 'bot.init')
      this.log.info('[telegram] bot.init ok', {
        username: this.bot.botInfo?.username,
      })
    } catch (err) {
      this.log.error('[telegram] bot.init failed:', describeError(err))
      throw err
    }

    await this.syncDefaultCommandMenu()

    this.destroyed = false
    this.reconnectAttempts = 0
    this.startPolling()
    // Do NOT set this.connected = true here — wait for onStart.
  }

  async setCommandMenu(commands: PlatformCommand[], opts?: CommandMenuOptions): Promise<void> {
    if (!this.bot) throw new Error('Telegram adapter not initialized')
    const normalized = normalizeCommandMenu(commands)
    await withTimeout(
      Promise.all(commandMenuTargets(opts).map((target) =>
        this.bot!.api.setMyCommands(
          normalized.map((command) => ({
            ...command,
            ...(target.isEphemeral ? { is_ephemeral: true } : {}),
          })) as typeof normalized,
          { scope: target.scope },
        )
      )),
      10_000,
      opts?.channelId ? 'setMyCommands:chat' : 'setMyCommands:global-scopes',
    )
  }

  private async syncDefaultCommandMenu(): Promise<void> {
    try {
      await this.setCommandMenu(TELEGRAM_BASE_COMMAND_MENU)
      this.log.info('[telegram] command menu synced', {
        event: 'telegram_commands_synced',
        commandCount: TELEGRAM_BASE_COMMAND_MENU.length,
      })
    } catch (err) {
      this.log.warn('[telegram] setMyCommands failed (non-fatal):', describeError(err))
    }
  }

  /**
   * Download a Telegram file to a temp path and invoke the message handler
   * with the resulting IncomingMessage. Centralised here so the five
   * `bot.on(...)` handlers only need to pick the right source fields.
   *
   * Failures (oversize, 404, network) are reported back to the sender via
   * `ctx.reply()` and logged. The message is NOT forwarded in that case —
   * the session should not be woken for an attachment we couldn't deliver.
   */
  private async emitAttachmentMessage(
    ctx: Context,
    meta: {
      type: IncomingAttachment['type']
      fileId: string
      fileName?: string
      fileSize?: number
      mimeType?: string
    },
  ): Promise<void> {
    if (!this.messageHandler || !ctx.message || !ctx.chat || !this.bot) return

    // Size guard BEFORE hitting the file API — avoids the round-trip when
    // Telegram already told us the size up-front.
    if (meta.fileSize !== undefined && meta.fileSize > MAX_ATTACHMENT_BYTES) {
      this.log.warn('[telegram] attachment too large, dropping', {
        type: meta.type,
        fileSize: meta.fileSize,
      })
      await ctx.reply(
        `Attachment too large (>${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB). Not forwarded.`,
      ).catch(() => {})
      return
    }

    let downloaded: { localPath: string; fileName: string; fileSize: number }
    try {
      downloaded = await this.downloadToTemp(
        meta.fileId,
        meta.fileName ?? `${meta.type}-${Date.now()}`,
        meta.mimeType,
      )
    } catch (err) {
      this.log.error('[telegram] attachment download failed:', describeError(err))
      await ctx.reply(
        'Failed to download your attachment. Please try again.',
      ).catch(() => {})
      return
    }

    const attachment: IncomingAttachment = {
      type: meta.type,
      fileId: meta.fileId,
      fileName: downloaded.fileName,
      mimeType: meta.mimeType,
      fileSize: downloaded.fileSize,
      localPath: downloaded.localPath,
    }

    const threadId = this.extractThreadId(ctx)
    const msg: IncomingMessage = {
      platform: 'telegram',
      channelId: String(ctx.chat.id),
      ...(threadId !== undefined ? { threadId } : {}),
      messageId: String(ctx.message.message_id),
      senderId: String(ctx.from?.id ?? ''),
      senderName: ctx.from?.first_name ?? undefined,
      ...(ctx.from?.username ? { senderUsername: ctx.from.username } : {}),
      ...(ctx.from?.is_bot ? { senderIsBot: true } : {}),
      text: ctx.message.caption ?? '',
      attachments: [attachment],
      timestamp: ctx.message.date * 1000,
      raw: ctx.message,
    }

    await this.messageHandler(msg)
  }

  /**
   * Resolve a Telegram `file_id` to a local path by calling `getFile()` to
   * obtain the remote path, then fetching the blob from the Bot API file
   * host and writing it to the OS temp dir. Enforces `MAX_ATTACHMENT_BYTES`
   * against the actual downloaded size in case `getFile` reported no size.
   */
  private async downloadToTemp(
    fileId: string,
    fallbackName: string,
    mimeType: string | undefined,
  ): Promise<{ localPath: string; fileName: string; fileSize: number }> {
    if (!this.bot) throw new Error('Telegram adapter not initialized')

    const file = await this.bot.api.getFile(fileId)
    if (!file.file_path) {
      throw new Error(`getFile returned no file_path for ${fileId}`)
    }
    if (file.file_size !== undefined && file.file_size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`file too large: ${file.file_size} bytes`)
    }

    // Extension: prefer whatever Telegram's file_path carries (it's normally
    // `photos/file_123.jpg` or similar), fall back to mime map, else `.bin`.
    let ext = extname(file.file_path)
    if (!ext && mimeType && MIME_EXT_FALLBACK[mimeType]) {
      ext = MIME_EXT_FALLBACK[mimeType]
    }
    if (!ext) ext = '.bin'

    // Normalise fileName — ensure it has the resolved extension so
    // readFileAttachment's extension-based type detection works.
    let fileName = fallbackName
    if (!extname(fileName)) fileName = `${fileName}${ext}`

    const url = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`download failed: ${res.status} ${res.statusText}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`file too large after download: ${buf.byteLength} bytes`)
    }

    const localPath = join(
      tmpdir(),
      `craft-agent-messaging-${randomBytes(8).toString('hex')}${ext}`,
    )
    writeFileSync(localPath, buf)
    return { localPath, fileName, fileSize: buf.byteLength }
  }

  /**
   * Launch polling. grammY's bot.start() runs until stop() is called or a
   * fatal error occurs. On unexpected failure we schedule a reconnect with
   * exponential backoff so transient issues (network blip, 409 from a
   * competing instance that quickly exits) self-heal without user action.
   *
   * 409 Conflict means another poller is active — we wait longer on the first
   * attempt to give the other instance time to exit before we retry.
   */
  private startPolling(): void {
    if (this.destroyed || !this.bot) return

    this.bot.start({
      onStart: () => {
        this.connected = true
        this.reconnectAttempts = 0
        this.log.info('[telegram] polling started')
        this.bot?.api.getWebhookInfo().then(
          (info) => this.log.info('[telegram] webhook state after start:', {
            url: info.url || null,
            pending_update_count: info.pending_update_count,
          }),
          () => {},
        )
      },
    }).catch((err: unknown) => {
      this.connected = false
      this.log.error('[telegram] polling stopped with error:', describeError(err))
      if (!this.destroyed) {
        this.scheduleReconnect(err)
      }
    })
  }

  private scheduleReconnect(err: unknown): void {
    if (this.destroyed || !this.bot) return

    this.reconnectAttempts++
    // 409 = another poller is competing; wait 30 s before first retry so the
    // other process has a chance to exit. Other errors start at 5 s.
    const is409 = err instanceof Error && err.message.includes('409')
    const baseDelay = is409 ? 30_000 : 5_000
    const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts - 1), 5 * 60_000)

    this.log.warn('[telegram] scheduling reconnect', {
      event: 'telegram_reconnect_scheduled',
      attempt: this.reconnectAttempts,
      delayMs: delay,
      is409,
    })

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.destroyed || !this.bot) return
      this.log.info('[telegram] attempting reconnect', {
        event: 'telegram_reconnect_attempt',
        attempt: this.reconnectAttempts,
      })
      this.startPolling()
    }, delay)
  }

  async destroy(): Promise<void> {
    this.destroyed = true
    this.connected = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.bot) {
      await this.bot.stop()
      this.bot = null
    }
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

  private async trySendEphemeralText(
    channelId: string,
    text: string,
    opts?: SendOptions,
    replyMarkup?: TelegramSendMessagePayload['reply_markup'],
  ): Promise<SentMessage | null> {
    const target = opts?.ephemeral
    if (!target) return null
    if (target.expiresAt !== undefined && Date.now() >= target.expiresAt) {
      this.log.info('[telegram] ephemeral reply window expired; using normal message', {
        event: 'telegram_ephemeral_expired',
        channelId,
        recipientId: target.recipientId,
      })
      return null
    }

    const send = async (formatted: string) => telegramRawApi(this.bot!).sendMessage({
      chat_id: telegramChatId(channelId),
      text: formatted,
      parse_mode: TELEGRAM_PARSE_MODE,
      ...threadParams(opts),
      ...ephemeralParams(target),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    })

    try {
      let sent: TelegramMessageResult
      try {
        sent = await send(formatForTelegram(text))
      } catch (err) {
        if (!isEntityParseError(err)) throw err
        sent = await send(formatPlainTextForTelegram(text))
      }
      return sentMessageResult(channelId, sent, target)
    } catch (err) {
      // Bot API rejects this after the 15-second window and when the bot is
      // not an administrator. The visible message is the reliable fallback.
      this.log.warn('[telegram] ephemeral send failed; using normal message', describeError(err))
      return null
    }
  }

  async sendText(channelId: string, text: string, opts?: SendOptions): Promise<SentMessage> {
    if (!this.bot) throw new Error('Telegram adapter not initialized')
    const ephemeral = await this.trySendEphemeralText(channelId, text, opts)
    if (ephemeral) return ephemeral
    const formatted = formatForTelegram(text)
    let sent: TelegramMessageResult
    try {
      sent = await this.bot.api.sendMessage(
        Number(channelId),
        formatted,
        sendTextOptions(opts),
      )
    } catch (err) {
      if (!isEntityParseError(err)) throw err
      this.log.warn('[telegram] sendMessage Markdown parse failed; retrying escaped plain text', describeError(err))
      sent = await this.bot.api.sendMessage(
        Number(channelId),
        formatPlainTextForTelegram(text),
        sendTextOptions(opts),
      )
    }
    return sentMessageResult(channelId, sent)
  }

  async sendMessageDraft(channelId: string, draftId: number, text: string, opts?: SendOptions): Promise<void> {
    if (!this.bot) throw new Error('Telegram adapter not initialized')
    const formatted = text ? truncateDraftText(formatForTelegram(text)) : ''
    try {
      await this.bot.api.sendMessageDraft(
        Number(channelId),
        draftId,
        formatted,
        sendTextOptions(opts),
      )
    } catch (err) {
      if (!isEntityParseError(err)) throw err
      this.log.warn('[telegram] sendMessageDraft Markdown parse failed; retrying escaped plain text', describeError(err))
      await this.bot.api.sendMessageDraft(
        Number(channelId),
        draftId,
        text ? truncateDraftText(formatPlainTextForTelegram(text)) : '',
        sendTextOptions(opts),
      )
    }
  }

  async sendRichMessage(channelId: string, markdown: string, opts?: SendOptions): Promise<SentMessage> {
    if (!this.bot) throw new Error('Telegram adapter not initialized')
    try {
      const sent = await telegramRawApi(this.bot).sendRichMessage({
        chat_id: telegramChatId(channelId),
        rich_message: buildTelegramRichMessage(markdown),
        ...threadParams(opts),
      })
      return sentMessageResult(channelId, sent)
    } catch (err) {
      this.log.warn('[telegram] sendRichMessage failed; caller may fall back to regular text', describeError(err))
      throw err
    }
  }

  async sendRichMessageDraft(channelId: string, draftId: number, markdown: string, opts?: SendOptions): Promise<void> {
    if (!this.bot) throw new Error('Telegram adapter not initialized')
    try {
      await telegramRawApi(this.bot).sendRichMessageDraft({
        chat_id: Number(channelId),
        draft_id: draftId,
        rich_message: buildTelegramRichMessage(markdown, { draft: true }),
        ...threadParams(opts),
      })
    } catch (err) {
      this.log.warn('[telegram] sendRichMessageDraft failed; caller may fall back to regular draft', describeError(err))
      throw err
    }
  }

  async sendRichMedia(
    channelId: string,
    file: Buffer,
    filename: string,
    caption?: string,
    opts?: SendOptions,
  ): Promise<SentMessage> {
    if (!this.bot) throw new Error('Telegram adapter not initialized')
    const kind = richMediaKind(filename)
    if (!kind) throw new Error(`Telegram rich messages do not support this media type: ${filename}`)
    const media: TelegramInputMedia = {
      type: kind,
      media: new InputFile(file, filename),
    } as TelegramInputMedia
    try {
      const sent = await telegramRawApi(this.bot).sendRichMessage({
        chat_id: telegramChatId(channelId),
        rich_message: buildTelegramRichMediaMessage(caption, media),
        ...threadParams(opts),
      })
      return sentMessageResult(channelId, sent)
    } catch (err) {
      this.log.warn('[telegram] rich media send failed; caller may fall back to attachment', describeError(err))
      throw err
    }
  }

  async editEphemeralMessage(
    channelId: string,
    message: EphemeralMessageReference,
    text: string,
  ): Promise<void> {
    if (!this.bot) throw new Error('Telegram adapter not initialized')
    const edit = (formatted: string) => telegramRawApi(this.bot!).editEphemeralMessageText({
      chat_id: telegramChatId(channelId),
      receiver_user_id: numericTelegramId(message.recipientId, 'recipient id'),
      ephemeral_message_id: numericTelegramId(message.messageId, 'ephemeral message id'),
      text: formatted,
      parse_mode: TELEGRAM_PARSE_MODE,
    })
    try {
      await edit(formatForTelegram(text))
    } catch (err) {
      if (!isEntityParseError(err)) throw err
      await edit(formatPlainTextForTelegram(text))
    }
  }

  async deleteEphemeralMessage(
    channelId: string,
    message: EphemeralMessageReference,
  ): Promise<void> {
    if (!this.bot) throw new Error('Telegram adapter not initialized')
    await telegramRawApi(this.bot).deleteEphemeralMessage({
      chat_id: telegramChatId(channelId),
      receiver_user_id: numericTelegramId(message.recipientId, 'recipient id'),
      ephemeral_message_id: numericTelegramId(message.messageId, 'ephemeral message id'),
    })
  }

  async editMessage(channelId: string, messageId: string, text: string, _opts?: SendOptions): Promise<void> {
    if (!this.bot) throw new Error('Telegram adapter not initialized')
    const formatted = formatForTelegram(text)
    // editMessageText is keyed by (chat_id, message_id) — Telegram does not
    // accept message_thread_id here. We accept the option for caller
    // uniformity but ignore it.
    try {
      await this.bot.api.editMessageText(Number(channelId), Number(messageId), formatted, {
        parse_mode: TELEGRAM_PARSE_MODE,
      })
    } catch (err) {
      if (!isEntityParseError(err)) throw err
      this.log.warn('[telegram] editMessage Markdown parse failed; retrying escaped plain text', describeError(err))
      await this.bot.api.editMessageText(
        Number(channelId),
        Number(messageId),
        formatPlainTextForTelegram(text),
        { parse_mode: TELEGRAM_PARSE_MODE },
      )
    }
  }

  async sendButtons(channelId: string, text: string, buttons: InlineButton[], opts?: SendOptions): Promise<SentMessage> {
    return this.sendButtonRows(channelId, text, buttons.map((button) => [button]), opts)
  }

  async sendButtonRows(channelId: string, text: string, rows: InlineButtonRow[], opts?: SendOptions): Promise<SentMessage> {
    if (!this.bot) throw new Error('Telegram adapter not initialized')

    const keyboard = {
      inline_keyboard: rows
        .filter((row) => row.length > 0)
        .map((row) => row.map((b) => ({
          text: b.label,
          callback_data: b.id,
        }))),
    }

    const ephemeral = await this.trySendEphemeralText(channelId, text, opts, keyboard)
    if (ephemeral) return ephemeral

    const sent = await this.bot.api.sendMessage(Number(channelId), formatForTelegram(text), {
      parse_mode: TELEGRAM_PARSE_MODE,
      reply_markup: keyboard,
      ...threadParams(opts),
    })

    return sentMessageResult(channelId, sent)
  }

  async sendTyping(channelId: string, opts?: SendOptions): Promise<void> {
    if (!this.bot) return
    await this.bot.api
      .sendChatAction(Number(channelId), 'typing', threadParams(opts))
      .catch(() => {})
  }

  async sendFile(channelId: string, file: Buffer, filename: string, caption?: string, opts?: SendOptions): Promise<SentMessage> {
    if (!this.bot) throw new Error('Telegram adapter not initialized')

    const chatId = Number(channelId)
    const makeInputFile = () => new InputFile(file, filename)
    const options = sendCaptionOptions(caption, opts)
    let sent: { message_id: number }

    if (isTelegramVoiceFile(filename)) {
      try {
        sent = await this.bot.api.sendVoice(chatId, makeInputFile(), options)
      } catch (err) {
        this.log.warn('[telegram] sendVoice failed; falling back for audio file:', describeError(err))
        if (isTelegramAudioFile(filename)) {
          try {
            sent = await this.bot.api.sendAudio(chatId, makeInputFile(), options)
          } catch (audioErr) {
            this.log.warn('[telegram] sendAudio fallback failed; sending as document:', describeError(audioErr))
            sent = await this.bot.api.sendDocument(chatId, makeInputFile(), options)
          }
        } else {
          sent = await this.bot.api.sendDocument(chatId, makeInputFile(), options)
        }
      }
    } else {
      sent = await this.bot.api.sendDocument(
        chatId,
        makeInputFile(),
        options,
      ).catch((err: unknown) => {
        this.log.error('[telegram] sendDocument failed:', describeError(err))
        throw err
      })
    }

    return {
      platform: 'telegram',
      channelId,
      messageId: String(sent.message_id),
    }
  }

  async clearButtons(channelId: string, messageId: string, _opts?: SendOptions): Promise<void> {
    if (!this.bot) return
    try {
      if (_opts?.ephemeral?.sourceMessageId) {
        await telegramRawApi(this.bot).editEphemeralMessageReplyMarkup({
          chat_id: telegramChatId(channelId),
          receiver_user_id: numericTelegramId(_opts.ephemeral.recipientId, 'recipient id'),
          ephemeral_message_id: numericTelegramId(_opts.ephemeral.sourceMessageId, 'ephemeral message id'),
          reply_markup: { inline_keyboard: [] },
        })
        return
      }
      // editMessageReplyMarkup is also keyed by (chat_id, message_id) only.
      await this.bot.api.editMessageReplyMarkup(Number(channelId), Number(messageId), {
        reply_markup: { inline_keyboard: [] },
      })
    } catch {
      // Non-fatal: message may have been deleted by the user or already cleared.
    }
  }

  /**
   * Phase B prep: create a new forum topic in a supergroup. Telegram returns
   * `{ message_thread_id, name, ... }`; we surface a normalised shape.
   *
   * Requires the bot to have "Manage Topics" admin permission in the
   * supergroup. If the call fails (privilege missing, chat is not a forum,
   * etc.), the error propagates so the caller can surface it.
   *
   * `iconColor` is intentionally omitted from this stub — grammY's typing
   * accepts only the six Telegram-defined palette ints. We'll plumb it
   * properly in Phase B when the automation feature actually picks colours.
   */
  async createForumTopic(
    chatId: string,
    name: string,
  ): Promise<{ threadId: number; name: string }> {
    if (!this.bot) throw new Error('Telegram adapter not initialized')
    const result = await this.bot.api.createForumTopic(Number(chatId), name)
    return { threadId: result.message_thread_id, name: result.name }
  }
}

/**
 * Build the `{ message_thread_id }` fragment passed to grammY API calls.
 * Returns an empty object when no thread is requested so the spread is a
 * no-op and Telegram receives no `message_thread_id` (which is what the
 * General topic / DM shapes expect).
 */
function threadParams(opts?: SendOptions): { message_thread_id?: number } {
  if (opts?.threadId === undefined) return {}
  return { message_thread_id: opts.threadId }
}
