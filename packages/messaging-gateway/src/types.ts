/**
 * Core types for the messaging gateway.
 *
 * Workspace-scoped bindings, platform adapter interface, runtime state, and
 * messaging-stack logging contracts.
 */

// ---------------------------------------------------------------------------
// Platform types
// ---------------------------------------------------------------------------

export type PlatformType = 'telegram' | 'whatsapp' | 'weixin' | 'lark'

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface MessagingLogContext {
  component?: string
  workspaceId?: string
  sessionId?: string
  platform?: string
  channelId?: string
  bindingId?: string
  event?: string
}

export type MessagingLogMeta = Record<string, unknown>

/**
 * Structured logger used by the messaging stack.
 *
 * Implementations should write structured logs and preserve contextual fields
 * added via `child(...)`.
 */
export interface MessagingLogger {
  info(message: string, meta?: MessagingLogMeta): void
  warn(message: string, meta?: MessagingLogMeta): void
  error(message: string, meta?: MessagingLogMeta): void
  child(context: MessagingLogContext): MessagingLogger
}

// ---------------------------------------------------------------------------
// Runtime platform status
// ---------------------------------------------------------------------------

export type MessagingPlatformRuntimeState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'degraded'
  | 'reconnect_required'
  | 'error'

export interface MessagingPlatformRuntimeInfo {
  platform: PlatformType
  configured: boolean
  connected: boolean
  state: MessagingPlatformRuntimeState
  identity?: string
  lastError?: string
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Adapter capabilities
// ---------------------------------------------------------------------------

export interface AdapterCapabilities {
  messageEditing: boolean
  inlineButtons: boolean
  /** Platform can address a short-lived reply to one participant in a group. */
  ephemeralMessages?: boolean
  /**
   * Platform supports ephemeral generated-message drafts. Telegram exposes
   * this as sendMessageDraft/sendRichMessageDraft; other adapters omit it.
   */
  messageDrafts?: boolean
  /** Platform supports Telegram-style rich messages for structured output. */
  richMessages?: boolean
  /** Platform supports ephemeral drafts backed by rich messages. */
  richMessageDrafts?: boolean
  /** Platform has a native streaming-card/message lifecycle. */
  nativeStreaming?: boolean
  /** Platform can reply to an exact source message or existing thread. */
  contextualReplies?: boolean
  /** Platform supports messages/cards visible only to one group member. */
  ephemeralCards?: boolean
  /** Platform supports image, file, audio, video, and sticker transport. */
  richMedia?: boolean
  maxButtons: number
  maxMessageLength: number
  markdown: 'v2' | 'whatsapp' | 'lark-post'
  webhookSupport: boolean
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface IncomingMessage {
  platform: PlatformType
  channelId: string
  /**
   * Telegram supergroup forum topic id (`message_thread_id`). Undefined for
   * DMs, the General topic, and non-forum chats. Only Telegram populates this.
   */
  threadId?: number
  /** Generic conversation kind used by contextual and private replies. */
  chatType?: 'direct' | 'group'
  /** Root message id when the platform models a threaded conversation. */
  rootMessageId?: string
  /** Platform-native thread id. Never participates in Telegram binding keys. */
  nativeThreadId?: string
  messageId: string
  senderId: string
  senderName?: string
  /**
   * Platform-native username if the user has one set. Telegram supplies this
   * via `from.username`; WhatsApp/Lark may leave it undefined. Used by the
   * access-control layer to render friendlier "pending requests" rows in the
   * Settings UI without forcing the operator to read raw user_ids.
   */
  senderUsername?: string
  /**
   * `true` when the platform marks the sender as a bot (Telegram `from.is_bot`).
   * Adapters use this to silently drop bot-to-bot traffic before it reaches
   * the router; surfaces in `IncomingMessage` so access-control can audit.
   */
  senderIsBot?: boolean
  text: string
  attachments?: IncomingAttachment[]
  replyToMessageId?: string
  /**
   * Short-lived, participant-scoped reply context supplied by the adapter.
   * Telegram populates this for group/supergroup messages. The gateway still
   * applies its normal access checks before using it.
   */
  ephemeralReply?: EphemeralReplyTarget
  timestamp: number
  raw: unknown
}

export interface IncomingAttachment {
  type: 'photo' | 'document' | 'voice' | 'video' | 'audio'
  fileId: string
  fileName?: string
  mimeType?: string
  fileSize?: number
  /**
   * Absolute path on local disk where the adapter has already downloaded the
   * blob. When set, the router wraps it with `readFileAttachment()` and
   * forwards it as a `FileAttachment` to the session. Adapters that emit
   * attachments MUST populate this — attachments without `localPath` are
   * dropped by the router.
   */
  localPath?: string
}

export interface SentMessage {
  platform: PlatformType
  channelId: string
  messageId: string
  /** Present when the platform returned a participant-scoped message id. */
  ephemeral?: EphemeralMessageReference
}

/** Generic participant-scoped reply context; native field names stay in adapters. */
export interface EphemeralReplyTarget {
  recipientId: string
  /** Identifier of the interaction that triggered the reply, if any. */
  interactionId?: string
  /** Identifier of an incoming ephemeral message being replied to, if any. */
  sourceMessageId?: string
  /** Local deadline for interaction/reply-window based delivery. */
  expiresAt?: number
}

export interface EphemeralMessageReference {
  recipientId: string
  messageId: string
}

export interface InlineButton {
  id: string
  label: string
  data?: string
}

export type InlineButtonRow = InlineButton[]

export interface PlatformCommand {
  /** Bot-API command name without the leading slash. */
  command: string
  description: string
}

export interface CommandMenuOptions {
  /**
   * Platform-native channel/chat id. Telegram applies this at chat scope; forum
   * topics inside a supergroup share the same chat-scoped menu.
   */
  channelId?: string
  /** Mark commands as participant-scoped where the platform supports it. */
  ephemeral?: boolean
}

export interface ButtonPress {
  platform: PlatformType
  channelId: string
  /** Forum topic id of the message the button was attached to (Telegram). */
  threadId?: number
  messageId: string
  senderId: string
  /** Optional sender display name (Telegram first name). For UI / pending list. */
  senderName?: string
  /** Optional sender username (Telegram @username, no `@`). For UI / pending list. */
  senderUsername?: string
  /** True when the platform marks the sender as a bot. Access control silent-drops these. */
  senderIsBot?: boolean
  /** Direct/group context when the callback payload exposes it. */
  chatType?: 'direct' | 'group'
  /** Participant-scoped context for replying to this interaction. */
  ephemeralReply?: EphemeralReplyTarget
  /** Participant-scoped id of the message that carried the button. */
  sourceEphemeral?: EphemeralMessageReference
  buttonId: string
  data?: string
}

/**
 * Per-call options for outbound adapter operations. Currently only Telegram
 * uses `threadId` (forum topic posting); other adapters ignore extra fields.
 */
export interface SendOptions {
  /** Telegram forum topic to post into. Undefined → DM or General topic. */
  threadId?: number
  /** Reply to this platform-native message id. */
  replyToMessageId?: string
  /** Keep the reply inside the source message's existing thread. */
  replyInThread?: boolean
  /** Prefer a participant-scoped group reply, falling back to normal delivery. */
  ephemeral?: EphemeralReplyTarget
}

export interface NativeStreamHandle {
  /** Adapter-owned opaque id. */
  id: string
  /** Platform message id once the stream card/message exists. */
  messageId?: string
}

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

export interface PlatformConfig {
  token?: string
  webhookUrl?: string
  webhookSecretToken?: string
  /**
   * Telegram only: a configured supergroup chatId. When set, the adapter
   * accepts messages from that chat (in addition to DMs); when unset,
   * the adapter is DM-only as before.
   */
  acceptedSupergroupChatId?: string
  /** Optional logger for adapter-level diagnostics. */
  logger?: MessagingLogger
  /** Optional adapter lifecycle/capability notification for registry UI state. */
  onRuntimeState?: (
    state: 'connecting' | 'connected' | 'degraded' | 'reconnecting' | 'error',
    detail?: string,
  ) => void
  [key: string]: unknown
}

export interface PlatformAdapter {
  readonly platform: PlatformType
  readonly capabilities: AdapterCapabilities

  initialize(config: PlatformConfig): Promise<void>
  destroy(): Promise<void>
  isConnected(): boolean

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void
  onButtonPress(handler: (press: ButtonPress) => Promise<void>): void

  sendText(channelId: string, text: string, opts?: SendOptions): Promise<SentMessage>
  editMessage(channelId: string, messageId: string, text: string, opts?: SendOptions): Promise<void>
  sendButtons(channelId: string, text: string, buttons: InlineButton[], opts?: SendOptions): Promise<SentMessage>
  sendButtonRows?(channelId: string, text: string, rows: InlineButtonRow[], opts?: SendOptions): Promise<SentMessage>
  sendTyping(channelId: string, opts?: SendOptions): Promise<void>
  sendFile(channelId: string, file: Buffer, filename: string, caption?: string, opts?: SendOptions): Promise<SentMessage>
  sendMessageDraft?(channelId: string, draftId: number, text: string, opts?: SendOptions): Promise<void>
  sendRichMessage?(channelId: string, markdown: string, opts?: SendOptions): Promise<SentMessage>
  sendRichMessageDraft?(channelId: string, draftId: number, markdown: string, opts?: SendOptions): Promise<void>
  beginNativeStream?(channelId: string, initialMarkdown: string, opts?: SendOptions): Promise<NativeStreamHandle>
  updateNativeStream?(handle: NativeStreamHandle, markdown: string): Promise<void>
  finishNativeStream?(handle: NativeStreamHandle, finalMarkdown: string): Promise<SentMessage>
  failNativeStream?(handle: NativeStreamHandle, fallbackMarkdown: string): Promise<void>
  sendEphemeralCard?(
    channelId: string,
    recipientId: string,
    markdown: string,
    buttons?: InlineButton[],
  ): Promise<SentMessage>
  /** Send an attachment as media inside a rich message when supported. */
  sendRichMedia?(channelId: string, file: Buffer, filename: string, caption?: string, opts?: SendOptions): Promise<SentMessage>
  editEphemeralMessage?(channelId: string, message: EphemeralMessageReference, text: string): Promise<void>
  deleteEphemeralMessage?(channelId: string, message: EphemeralMessageReference): Promise<void>
  setCommandMenu?(commands: PlatformCommand[], opts?: CommandMenuOptions): Promise<void>

  /**
   * Clear the inline keyboard on a previously-sent message. Optional because
   * only platforms with inline-button support (currently Telegram) need it.
   * Errors are the caller's concern — most implementations should swallow
   * "message can't be edited" since it's non-fatal.
   */
  clearButtons?(
    channelId: string,
    messageId: string,
    opts?: SendOptions,
    resolution?: string,
  ): Promise<void>

  /**
   * Update the set of chats the adapter accepts inbound messages from at
   * runtime, without restarting the polling loop. Telegram uses this to
   * (de)authorise a supergroup chatId after the user pairs/unpairs it in
   * Settings. Adapters that don't have a configurable filter can implement
   * this as a no-op.
   */
  setAcceptedSupergroupChatId?(chatId: string | undefined): void

  /**
   * Telegram-only: create a new forum topic in a supergroup. Used by
   * automation integrations that auto-spawn topics per session. Other
   * platforms throw or omit the method.
   */
  createForumTopic?(chatId: string, name: string): Promise<{ threadId: number; name: string }>

  /** Webhook handler for headless server (Telegram only). */
  handleWebhook?(request: Request): Promise<Response>
}

// ---------------------------------------------------------------------------
// Channel binding
// ---------------------------------------------------------------------------

/**
 * How agent output is rendered to the chat.
 *
 * - `streaming` — legacy behaviour: live edits during the final turn, and
 *   every intermediate `text_complete` starts a fresh message. Produces
 *   multiple messages per agent run. Kept for parity with in-app UI.
 * - `progress` — one evolving message per run. Posts a "💭 thinking…"
 *   bubble on first activity, edits it as tools run, replaces it with
 *   the final answer on `complete`. Intermediate assistant text is
 *   dropped. Default for new bindings.
 * - `final_only` — silent until `complete`, then one message with the
 *   final text. Nothing is posted if the run has no final text.
 */
export type ResponseMode = 'streaming' | 'progress' | 'final_only'

/**
 * Per-binding access policy.
 *
 * - `inherit`     — defer to the platform's owners list (default for new bindings).
 * - `allow-list`  — only senders in `allowedSenderIds` may route to the bound session.
 * - `open`        — anyone in an accepted chat may route. Used as the migration
 *                   default for bindings created before access control existed,
 *                   and for explicitly-public bindings (e.g. support bots).
 */
export type BindingAccessMode = 'inherit' | 'allow-list' | 'open'

export interface BindingConfig {
  /** How outbound agent output is rendered. Default: 'progress' */
  responseMode: ResponseMode
  /**
   * @deprecated Use `responseMode` instead. Retained so persisted configs
   * written by older versions keep validating; the renderer ignores this
   * field when `responseMode` is present.
   */
  streamResponses: boolean
  /** Show compact tool activity summaries. Default: false */
  showToolActivity: boolean
  /** WHERE approval happens (not WHETHER — session mode is authoritative). */
  approvalChannel: 'chat' | 'app'
  /** Telegram edit interval in ms. ~3500ms stays under 20 edits/min. */
  editIntervalMs: number
  /**
   * Per-binding access mode. Governs Router.route() admission for this
   * binding only. Defaults vary by migration vs. fresh creation:
   *  - Fresh bindings (created after access control shipped): `'inherit'`.
   *  - Migrated bindings (legacy data with no field set): `'open'` so prod
   *    behaviour is unchanged until the owner explicitly locks down.
   */
  accessMode: BindingAccessMode
  /**
   * Sender ids permitted to route into this binding when `accessMode === 'allow-list'`.
   * Ignored otherwise. The list is platform-native (Telegram numeric user_id
   * as a string).
   */
  allowedSenderIds: string[]
}

export const DEFAULT_BINDING_CONFIG: BindingConfig = {
  responseMode: 'progress',
  streamResponses: true,
  showToolActivity: false,
  approvalChannel: 'chat',
  editIntervalMs: 3500,
  accessMode: 'inherit',
  allowedSenderIds: [],
}

export function getDefaultBindingConfig(platform: PlatformType): BindingConfig {
  return {
    ...DEFAULT_BINDING_CONFIG,
    approvalChannel:
      platform === 'whatsapp' || platform === 'weixin'
        ? 'app'
        : DEFAULT_BINDING_CONFIG.approvalChannel,
  }
}

export function normalizeBindingConfig(
  platform: PlatformType,
  config?: Partial<BindingConfig>,
): BindingConfig {
  const base = getDefaultBindingConfig(platform)
  const resolvedResponseMode: ResponseMode =
    config?.responseMode ??
    (config?.streamResponses === false ? 'final_only' : config?.streamResponses === true ? 'streaming' : base.responseMode)

  // Migration rule: if a persisted config predates access control (no
  // `accessMode` field), treat the binding as `'open'` so prod behaviour
  // doesn't change silently. Owners explicitly lock down via Settings.
  const accessMode: BindingAccessMode =
    config?.accessMode ?? (config !== undefined ? 'open' : base.accessMode)

  const allowedSenderIds = Array.isArray(config?.allowedSenderIds)
    ? [...config!.allowedSenderIds]
    : []

  return {
    ...base,
    ...config,
    responseMode: resolvedResponseMode,
    approvalChannel:
      platform === 'whatsapp' || platform === 'weixin'
        ? 'app'
        : (config?.approvalChannel ?? base.approvalChannel),
    accessMode,
    allowedSenderIds,
  }
}

export interface ChannelBinding {
  id: string
  workspaceId: string
  sessionId: string
  platform: PlatformType
  channelId: string
  /**
   * Telegram supergroup forum topic id. Undefined = DM, General topic, or
   * non-Telegram. Eviction on `bind()` keys on `(platform, channelId, threadId ?? null)`,
   * so DMs and topics in the same supergroup are independently bindable.
   */
  threadId?: number
  channelName?: string
  enabled: boolean
  createdAt: number
  config: BindingConfig
}

// ---------------------------------------------------------------------------
// Gateway config (persisted per workspace)
// ---------------------------------------------------------------------------

/**
 * Workspace-level Telegram supergroup ("forum") configuration. When set,
 * the adapter accepts messages from this chat (in addition to DMs) and
 * sessions can be bound to specific topics inside it.
 *
 * Captured by typing `/pair <code>` in the supergroup with a workspace-
 * supergroup-kind pairing code. The bot reads the chat title from
 * `getChat()` once and stores it for display only.
 */
export interface TelegramSupergroupConfig {
  /** Telegram chat_id of the supergroup, e.g. `"-1001234567890"`. */
  chatId: string
  /** Display title captured at pairing time. Refreshed on next successful connect. */
  title: string
  /** Unix-ms timestamp when the supergroup was paired. */
  capturedAt: number
}

/**
 * Workspace-level access policy for a messaging platform.
 *
 * - `open`        — anyone in an accepted chat can run pre-binding commands
 *                   (`/new`, `/bind`) and bound chats fall back to their own
 *                   `BindingConfig.accessMode` for routing.
 * - `owner-only`  — pre-binding commands require sender to be on the
 *                   platform's `owners` list. Bindings whose `accessMode`
 *                   is `'inherit'` use the same list as their allow-list.
 *
 * Defaults vary by migration vs. fresh setup:
 *  - Fresh workspaces pairing the bot for the first time → `'owner-only'`.
 *  - Existing workspaces that predate access control → `'open'` so the
 *    Settings UI can show a "Lock down" banner without breaking traffic.
 */
export type PlatformAccessMode = 'open' | 'owner-only'

/**
 * A user authorised to interact with the workspace's bot. Platform-native
 * `userId` (Telegram numeric user_id as a string). `displayName` and
 * `username` are best-effort metadata captured when the user pairs or sends
 * a message; they're for UI rendering only.
 */
export interface PlatformOwner {
  userId: string
  displayName?: string
  username?: string
  /** Unix-ms when this owner was added to the list. */
  addedAt: number
}

/**
 * Why a sender ended up in the pending list. Drives the UI's "Allow"
 * button: promoting a workspace-level reject is different from promoting
 * a binding-allow-list reject, and conflating them silently was a real
 * privilege-escalation footgun.
 *
 * - `not-owner` — workspace-level pre-binding reject. Allowing means
 *   adding the sender to `platforms.{platform}.owners`.
 * - `not-on-binding-allowlist` — binding-level reject. Allowing means
 *   appending the sender to that binding's `allowedSenderIds`, NOT
 *   touching workspace owners.
 */
export type PendingRejectReason = 'not-owner' | 'not-on-binding-allowlist'

/**
 * A sender the gateway recently rejected. Surfaces in the Settings UI so
 * the operator can promote them with one click instead of typing numeric
 * ids by hand.
 *
 * The store is bounded (LRU + TTL) — see `pending-senders.ts`. Persistence
 * is best-effort: losing the file just means the operator has to wait for
 * the user to attempt access again.
 *
 * Same `(platform, userId)` is allowed to appear multiple times when the
 * sender hits *different* bindings — the operator needs to see (and
 * decide on) each binding-level reject separately rather than having
 * the second silently overwrite the first.
 */
export interface PendingSender {
  /** Platform identity. */
  platform: PlatformType
  userId: string
  displayName?: string
  username?: string
  /** Unix-ms of the most recent rejected attempt. */
  lastAttemptAt: number
  /** Total attempts since this sender first appeared in the pending list. */
  attemptCount: number
  /**
   * Why the sender was rejected. Optional for back-compat with persisted
   * entries written by an earlier build that lacked the field; missing
   * `reason` is treated as `'not-owner'` (the safer default).
   */
  reason?: PendingRejectReason
  /**
   * Binding the reject was scoped to. Only present when
   * `reason === 'not-on-binding-allowlist'`. Lets the operator's "Allow"
   * action target the right binding's `allowedSenderIds`.
   */
  bindingId?: string
  sessionId?: string
  channelId?: string
  threadId?: number
}

export interface MessagingConfig {
  enabled: boolean
  platforms: {
    telegram?: {
      enabled: boolean
      /**
       * Optional configured supergroup. Adapter accepts messages from this
       * chat in addition to DMs. Sessions can bind to specific topics within.
       */
      supergroup?: TelegramSupergroupConfig
      /**
       * Workspace-level access policy. Missing field = `'open'` for back-
       * compat with workspaces that predate access control. Fresh setups
       * land on `'owner-only'` automatically (registry sets it on first pair).
       */
      accessMode?: PlatformAccessMode
      /**
       * Telegram user ids permitted to drive the bot at workspace level.
       * Gates `/new`, `/bind`, `/unbind`, `/status`, `/stop` and serves as
       * the default sender allow-list for bindings whose `accessMode === 'inherit'`.
       *
       * `/pair` itself stays open: if the list is empty, the first
       * successful redeem seeds the list with the consuming sender. After
       * that, only existing owners may redeem further codes.
       */
      owners?: PlatformOwner[]
    }
    whatsapp?: {
      enabled: boolean
      /**
       * When true, messages sent from other devices on the same WA account
       * to the self-JID (your own number) are routed to a bound session.
       * The worker filters its own echoes via sent-ID tracking + a response
       * prefix. Defaults to `true` when unset — the no-second-phone flow is
       * the expected UX for new users.
       */
      selfChatMode?: boolean
    }
    weixin?: {
      enabled: boolean
    }
    lark?: {
      enabled: boolean
      /**
       * Which Lark/Feishu domain the bot belongs to. A bot is registered
       * with one Open Platform — they're separate ecosystems despite
       * sharing the same SDK + protocols.
       *  - `lark` → open.larksuite.com (international)
       *  - `feishu` → open.feishu.cn (China)
       */
      domain?: 'lark' | 'feishu'
      /** Workspace-level access policy, shared with Telegram semantics. */
      accessMode?: PlatformAccessMode
      /** Lark/Feishu open_ids allowed to act as workspace owners. */
      owners?: PlatformOwner[]
    }
  }
}

export const DEFAULT_MESSAGING_CONFIG: MessagingConfig = {
  enabled: false,
  platforms: {},
}
