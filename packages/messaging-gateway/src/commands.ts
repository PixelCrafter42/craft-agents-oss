/**
 * Commands — handles chat commands from unbound or bound channels.
 *
 * /new [name]    — create session + bind
 * /bind          — list recent sessions (or by id / index)
 * /pair <code>   — finish a session-initiated pairing flow
 * /unbind        — disconnect channel
 * /help          — show available commands
 * /menu          — show interactive Telegram-style menu
 * /skills        — list Craft skills available to the bound session
 * /use <skill>   — invoke a Craft skill for the bound session
 * /status        — show current binding
 * /stop          — abort the current agent run
 */

import type { Workspace } from '@craft-agent/core/types'
import type { ISessionManager } from '@craft-agent/server-core/handlers'
import type { Session } from '@craft-agent/shared/protocol'
import { loadAllSkills, loadSkillBySlug, type LoadedSkill } from '@craft-agent/shared/skills'
import {
  evaluateBindingAccess,
  evaluatePreBindingAccess,
  executeRejection,
  readPlatformAccessMode,
  readPlatformOwners,
  type AccessRejectReason,
} from './access-control'
import type { BindingStore } from './binding-store'
import type { PendingSendersStore } from './pending-senders'
import type {
  ButtonPress,
  ChannelBinding,
  InlineButton,
  InlineButtonRow,
  IncomingMessage,
  MessagingConfig,
  MessagingLogger,
  PlatformCommand,
  PlatformAdapter,
  PlatformOwner,
  PlatformType,
} from './types'

const NOOP_LOGGER: MessagingLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
}

/**
 * Result of consuming a pairing code. The `kind` discriminator tells the
 * caller which downstream flow to run (bind a session, or register the
 * supergroup chat at the workspace level).
 */
export type PairingConsumeResult =
  | { kind: 'session'; workspaceId: string; sessionId: string }
  | { kind: 'workspace-supergroup'; workspaceId: string }

/**
 * Supplied by the registry. The gateway passes the consumer down to Commands so
 * /pair can redeem codes issued via the app UI. Only codes belonging to the
 * gateway's own workspace are honored.
 */
export interface PairingCodeConsumer {
  /**
   * Returns whether this sender may still attempt a /pair consume this minute.
   * Defence-in-depth against brute-forcing the 6-digit code. Counted on entry,
   * not after validation, so wrong guesses consume budget too.
   */
  canConsume(platform: PlatformType, senderId: string): boolean
  /** Returns the pending pairing if the code is valid, or null. */
  consume(platform: PlatformType, code: string): PairingConsumeResult | null
  /**
   * Register the supergroup that just paired itself. Invoked from
   * Commands.handlePair when the consumed code's kind is
   * `workspace-supergroup`. Performs the persistence + adapter-reconfigure
   * dance that lives in the registry.
   */
  bindWorkspaceSupergroup?(args: {
    platform: PlatformType
    chatId: string
    /** Optional fall-back display name; the registry can fetch a real one via getChat. */
    fallbackTitle?: string
  }): Promise<{ title: string }>
}

/**
 * Access-control wiring supplied by the gateway. Commands consults the
 * workspace config on every command invocation (so config edits take effect
 * without restart) and uses `seedOwnerOnFirstPair` to bootstrap ownership
 * the first time anyone redeems a pairing code.
 */
export interface AccessControlDeps {
  getWorkspaceConfig: () => MessagingConfig
  /**
   * Append the sender to the platform's owners list iff the list is currently
   * empty for that platform. Returns the updated list (or the existing list
   * if the seed didn't run). Called from `/pair` consume.
   */
  seedOwnerOnFirstPair: (
    platform: PlatformType,
    candidate: PlatformOwner,
  ) => Promise<PlatformOwner[]>
  /** Optional pending-senders store for recording rejected attempts. */
  pendingStore?: PendingSendersStore
}

/**
 * Commands the gateway lets *anyone* run, regardless of ownership. `/pair`
 * is the bootstrap exception (first sender to redeem becomes owner) and
 * `/help` is informational.
 */
const ALWAYS_ALLOWED_COMMANDS = new Set(['/pair', '/help'])
const SKILL_SHORTCUT_PREFIX = 's_'
const MAX_SKILLS_IN_REPLY = 40
const MENU_SKILLS_PAGE_SIZE = 6
const PENDING_SKILL_TTL_MS = 5 * 60 * 1000
const TELEGRAM_COMMAND_MAX_LEN = 32

export interface SkillCommandResolver {
  listSkills(workspaceRoot: string, projectRoot?: string): LoadedSkill[]
  loadSkill(workspaceRoot: string, slug: string, projectRoot?: string): LoadedSkill | null
}

export interface CommandRuntimeDeps {
  skillResolver?: SkillCommandResolver
  ensureSessionCallbacks?: (sessionId: string) => void
}

interface SkillCommandEntry {
  command: string
  skill: LoadedSkill
}

interface SkillCommandContext {
  binding: ChannelBinding
  session: Session
  workspace: Workspace
  replyOpts: { threadId?: number }
}

interface PendingSkillInvocation {
  skillSlug: string
  skillName: string
  expiresAt: number
}

const DEFAULT_SKILL_RESOLVER: SkillCommandResolver = {
  listSkills: loadAllSkills,
  loadSkill: loadSkillBySlug,
}

const BASE_COMMAND_MENU: PlatformCommand[] = [
  { command: 'menu', description: 'Open the interactive menu' },
  { command: 'pair', description: 'Redeem a pairing code' },
]

/**
 * Telegram (and other Bot-API platforms) lets users address commands to
 * specific bots in shared chats: `/pair@MyBot 123456`. Without stripping
 * the `@BotName` suffix, the cmd token doesn't match our switch cases and
 * supergroup pairing breaks for users typing the canonical group form.
 *
 * Returns `{ cmd: '', args: '' }` for non-command text. Lower-cases the
 * cmd so callsites can do exact-string comparisons.
 */
export function parseCommand(text: string): { cmd: string; args: string } {
  const trimmed = text.trim()
  const m = trimmed.match(/^\/([a-z0-9_]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i)
  if (!m) return { cmd: '', args: '' }
  return { cmd: '/' + m[1]!.toLowerCase(), args: (m[2] ?? '').trim() }
}

function compareSkills(a: LoadedSkill, b: LoadedSkill): number {
  const aName = a.metadata.name || a.slug
  const bName = b.metadata.name || b.slug
  return aName.localeCompare(bName) || a.slug.localeCompare(b.slug)
}

function compactWhitespace(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function truncateText(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 3)).trimEnd()}...`
}

function hashSlug(slug: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < slug.length; i++) {
    hash ^= slug.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36).padStart(7, '0').slice(0, 4)
}

function sanitizeSkillAliasBase(slug: string): string {
  const base = slug
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
  return base || 'skill'
}

function uniqueSkillCommand(base: string, slug: string, used: Set<string>): string {
  let command = `${SKILL_SHORTCUT_PREFIX}${base}`.slice(0, TELEGRAM_COMMAND_MAX_LEN).replace(/_+$/g, '')
  if (!used.has(command)) return command

  const hash = hashSlug(slug)
  const maxBaseLen = TELEGRAM_COMMAND_MAX_LEN - SKILL_SHORTCUT_PREFIX.length - hash.length - 1
  const hashedBase = base.slice(0, maxBaseLen).replace(/_+$/g, '') || 'skill'
  command = `${SKILL_SHORTCUT_PREFIX}${hashedBase}_${hash}`

  let suffix = 2
  while (used.has(command)) {
    const suffixText = String(suffix++)
    const maxWithSuffix = TELEGRAM_COMMAND_MAX_LEN - SKILL_SHORTCUT_PREFIX.length - hash.length - suffixText.length - 2
    const suffixedBase = base.slice(0, maxWithSuffix).replace(/_+$/g, '') || 'skill'
    command = `${SKILL_SHORTCUT_PREFIX}${suffixedBase}_${hash}_${suffixText}`
  }
  return command
}

function buildSkillCommandEntries(skills: LoadedSkill[]): SkillCommandEntry[] {
  const used = new Set<string>()
  return [...skills].sort(compareSkills).map((skill) => {
    const command = uniqueSkillCommand(sanitizeSkillAliasBase(skill.slug), skill.slug, used)
    used.add(command)
    return { command, skill }
  })
}

function parseSkillInvocationArgs(args: string): { skill: string; prompt: string } | null {
  const trimmed = args.trim()
  if (!trimmed) return null
  const m = trimmed.match(/^(\S+)(?:\s+([\s\S]+))?$/)
  if (!m) return null
  const skill = m[1]!.trim()
  const prompt = (m[2] ?? '').trim()
  if (!skill || !prompt) return null
  return { skill, prompt }
}

function chunkButtons(buttons: InlineButton[], columns: number): InlineButtonRow[] {
  const rows: InlineButtonRow[] = []
  for (let i = 0; i < buttons.length; i += columns) {
    rows.push(buttons.slice(i, i + columns))
  }
  return rows
}

export class Commands {
  private readonly log: MessagingLogger
  private readonly access: AccessControlDeps
  private readonly skillResolver: SkillCommandResolver
  private readonly ensureSessionCallbacks?: (sessionId: string) => void
  private readonly recentRejectReplies = new Map<string, number>()
  private readonly pendingSkillInvocations = new Map<string, PendingSkillInvocation>()

  constructor(
    private readonly sessionManager: ISessionManager,
    private readonly bindingStore: BindingStore,
    private readonly workspaceId: string,
    private readonly pairingConsumer?: PairingCodeConsumer,
    logger: MessagingLogger = NOOP_LOGGER,
    access: AccessControlDeps = {
      getWorkspaceConfig: () => ({ enabled: false, platforms: {} }),
      seedOwnerOnFirstPair: async () => [],
    },
    runtimeDeps: CommandRuntimeDeps = {},
  ) {
    this.log = logger
    this.access = access
    this.skillResolver = runtimeDeps.skillResolver ?? DEFAULT_SKILL_RESOLVER
    this.ensureSessionCallbacks = runtimeDeps.ensureSessionCallbacks
  }

  async handle(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    const text = msg.text.trim()
    const replyOpts = msg.threadId !== undefined ? { threadId: msg.threadId } : {}

    // Pre-binding gate: every inbound stimulus runs through the access
    // evaluator, including non-command free-form text. Without this,
    // a stranger DMing "hi" would receive the help message (revealing
    // commands) and bypass the pending-senders flow. Only `/pair`
    // (bootstrap) and `/help` (informational) skip the gate.
    const cmd = parseCommand(text).cmd
    const skipsGate = cmd && ALWAYS_ALLOWED_COMMANDS.has(cmd)
    if (!skipsGate) {
      const verdict = evaluatePreBindingAccess({
        msg,
        workspaceConfig: this.access.getWorkspaceConfig(),
      })
      if (!verdict.allow) {
        await this.sendRejection(adapter, msg, verdict.reason)
        return
      }
    }

    // Exact-cmd dispatch (parsed; supports `/cmd@BotName`). Avoids the old
    // `text.startsWith('/new')` bug where `/newuser` would also dispatch
    // to handleNew.
    if (cmd === '/new') {
      await this.handleNew(adapter, msg)
    } else if (cmd === '/bind') {
      await this.handleBind(adapter, msg)
    } else if (cmd === '/pair') {
      await this.handlePair(adapter, msg)
    } else if (cmd === '/unbind') {
      await this.handleUnbind(adapter, msg)
    } else if (cmd === '/help') {
      await this.handleHelp(adapter, msg)
    } else if (cmd === '/menu') {
      await this.handleMenu(adapter, msg)
    } else if (cmd === '/skills') {
      await this.handleSkills(adapter, msg)
    } else if (cmd === '/use' || cmd === '/skill') {
      await this.handleUse(adapter, msg)
    } else if (cmd.startsWith(`/${SKILL_SHORTCUT_PREFIX}`)) {
      await this.handleSkillShortcut(adapter, msg, cmd.slice(1))
    } else {
      // Sender passed the access gate (owner or open workspace) and typed
      // free-form text into a chat with no binding. Show the help prompt.
      await adapter.sendText(
        msg.channelId,
        'No session bound to this chat.\n\n' +
        '/new [name] — start a new session\n' +
        '/bind — connect to an existing session\n' +
        '/pair <code> — redeem a pairing code from the app\n' +
        '/menu — open interactive menu\n' +
        '/skills — list Craft skills after binding\n' +
        '/help — show all commands',
        replyOpts,
      )
    }
  }

  async handleCommand(adapter: PlatformAdapter, msg: IncomingMessage): Promise<boolean> {
    const text = msg.text.trim()
    if (!text.startsWith('/')) return false

    // Strip the optional `@BotName` suffix Telegram uses to disambiguate
    // commands in shared chats. Without this, `/pair@MyBot 123456` would
    // never match the switch case below.
    const { cmd } = parseCommand(text)
    if (!cmd) return false

    this.log.info('handling chat command', {
      event: 'command_received',
      workspaceId: this.workspaceId,
      platform: adapter.platform,
      channelId: msg.channelId,
      senderId: msg.senderId,
      command: cmd,
    })

    // Pre-binding gate for commands that arrive directly (i.e. typed inside
    // an already-bound chat — `gateway.wireAdapter` always tries
    // `handleCommand` before `router.route`). `/pair` and `/help` always pass.
    if (!ALWAYS_ALLOWED_COMMANDS.has(cmd)) {
      const verdict = evaluatePreBindingAccess({
        msg,
        workspaceConfig: this.access.getWorkspaceConfig(),
      })
      if (!verdict.allow) {
        await this.sendRejection(adapter, msg, verdict.reason)
        return true
      }
    }

    switch (cmd) {
      case '/new':
        await this.handleNew(adapter, msg)
        return true
      case '/bind':
        await this.handleBind(adapter, msg)
        return true
      case '/pair':
        await this.handlePair(adapter, msg)
        return true
      case '/unbind':
        await this.handleUnbind(adapter, msg)
        return true
      case '/help':
        await this.handleHelp(adapter, msg)
        return true
      case '/menu':
        await this.handleMenu(adapter, msg)
        return true
      case '/skills':
        await this.handleSkills(adapter, msg)
        return true
      case '/use':
      case '/skill':
        await this.handleUse(adapter, msg)
        return true
      case '/status':
        await this.handleStatus(adapter, msg)
        return true
      case '/stop':
        await this.handleStop(adapter, msg)
        return true
      default:
        if (cmd.startsWith(`/${SKILL_SHORTCUT_PREFIX}`)) {
          await this.handleSkillShortcut(adapter, msg, cmd.slice(1))
          return true
        }
        return false
    }
  }

  /**
   * Reject reply for pre-binding gating. Delegates to the shared
   * `executeRejection` so text and button paths emit identical output.
   */
  private async sendRejection(
    adapter: PlatformAdapter,
    msg: IncomingMessage,
    reason: AccessRejectReason,
    extra: { bindingId?: string; sessionId?: string } = {},
  ): Promise<void> {
    await executeRejection(
      adapter,
      msg,
      reason,
      {
        recentRejectReplies: this.recentRejectReplies,
        ...(this.access.pendingStore ? { pendingStore: this.access.pendingStore } : {}),
      },
      this.log,
      extra,
    )
  }

  // -------------------------------------------------------------------------
  // Command handlers
  // -------------------------------------------------------------------------

  async consumePendingSkill(adapter: PlatformAdapter, msg: IncomingMessage): Promise<boolean> {
    const text = msg.text.trim()
    if (!text || text.startsWith('/') || msg.attachments?.length) return false

    const key = this.pendingSkillKey(msg)
    const pending = this.pendingSkillInvocations.get(key)
    if (!pending) return false
    if (Date.now() > pending.expiresAt) {
      this.pendingSkillInvocations.delete(key)
      return false
    }

    const context = await this.resolveBoundSkillContext(adapter, msg)
    if (!context) {
      this.pendingSkillInvocations.delete(key)
      return true
    }

    const skill = this.resolveSkill(context, pending.skillSlug)
    if (!skill) {
      this.pendingSkillInvocations.delete(key)
      await adapter.sendText(
        msg.channelId,
        `Skill no longer available: ${pending.skillSlug}`,
        context.replyOpts,
      )
      return true
    }

    this.pendingSkillInvocations.delete(key)
    await this.invokeSkill(adapter, msg, context, skill, text)
    return true
  }

  async handleMenuButton(adapter: PlatformAdapter, press: ButtonPress): Promise<boolean> {
    if (!press.buttonId.startsWith('menu:')) return false

    const msg = this.messageFromButtonPress(press)
    const replyOpts = press.threadId !== undefined ? { threadId: press.threadId } : {}
    if (adapter.clearButtons && press.messageId) {
      await adapter.clearButtons(press.channelId, press.messageId, replyOpts).catch(() => {})
    }

    const parts = press.buttonId.split(':')
    const action = parts[1] ?? ''
    switch (action) {
      case 'home':
        await this.sendHomeMenu(adapter, msg)
        return true
      case 'new':
        await this.handleNew(adapter, { ...msg, text: '/new' })
        return true
      case 'sessions':
        await this.sendSessionsMenu(adapter, msg)
        return true
      case 'skills':
        await this.sendSkillsMenu(adapter, msg, Number(parts[2] ?? 0) || 0)
        return true
      case 'skill':
        await this.sendSkillDetailMenu(adapter, msg, parts[2] ?? '')
        return true
      case 'use':
        await this.armPendingSkill(adapter, msg, parts[2] ?? '')
        return true
      case 'cancel_use':
        this.pendingSkillInvocations.delete(this.pendingSkillKey(msg))
        await adapter.sendText(press.channelId, 'Skill prompt cancelled.', replyOpts)
        return true
      case 'status':
        await this.handleStatus(adapter, msg)
        return true
      case 'stop':
        await this.handleStop(adapter, msg)
        return true
      case 'pair_help':
        await adapter.sendText(
          press.channelId,
          'Pairing: generate a 6-digit code in the Craft Agents app, then send /pair <code> here.',
          replyOpts,
        )
        return true
      case 'help':
        await this.handleHelp(adapter, msg)
        return true
      case 'close':
        return true
      default:
        return true
    }
  }

  private async handleMenu(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    await this.syncCompactCommandMenu(adapter, msg)
    if (!adapter.capabilities.inlineButtons) {
      await this.handleHelp(adapter, msg)
      return
    }
    await this.sendHomeMenu(adapter, msg)
  }

  private async sendHomeMenu(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    const replyOpts = msg.threadId !== undefined ? { threadId: msg.threadId } : {}
    const binding = this.bindingStore.findByChannel(adapter.platform, msg.channelId, msg.threadId)
    const session = binding ? await this.sessionManager.getSession(binding.sessionId) : null
    const boundLine = binding
      ? `Bound to "${session?.name || binding.sessionId.slice(0, 8)}".`
      : 'No session is bound to this chat.'

    const rows: InlineButtonRow[] = binding
      ? [
          [
            { id: 'menu:skills:0', label: 'Skills' },
            { id: 'menu:status', label: 'Status' },
          ],
          [
            { id: 'menu:sessions', label: 'Sessions' },
            { id: 'menu:stop', label: 'Stop' },
          ],
          [
            { id: 'menu:new', label: 'New Session' },
            { id: 'menu:help', label: 'Help' },
          ],
          [{ id: 'menu:close', label: 'Close' }],
        ]
      : [
          [
            { id: 'menu:new', label: 'New Session' },
            { id: 'menu:sessions', label: 'Bind Session' },
          ],
          [
            { id: 'menu:pair_help', label: 'Pair Help' },
            { id: 'menu:help', label: 'Help' },
          ],
          [{ id: 'menu:close', label: 'Close' }],
        ]

    await this.sendButtonRows(
      adapter,
      msg.channelId,
      `Craft Agents Menu\n\n${boundLine}\nWhat do you want to do?`,
      rows,
      replyOpts,
    )
  }

  private async sendSessionsMenu(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    const replyOpts = msg.threadId !== undefined ? { threadId: msg.threadId } : {}
    const recent = this.getRecentSessions()
    if (recent.length === 0) {
      await this.sendButtonRows(
        adapter,
        msg.channelId,
        'No sessions found. Create a new session?',
        [
          [{ id: 'menu:new', label: 'New Session' }],
          [{ id: 'menu:home', label: 'Back' }],
        ],
        replyOpts,
      )
      return
    }

    const maxSessionButtons = Math.max(1, adapter.capabilities.maxButtons - 1)
    const sessionButtons = recent.slice(0, maxSessionButtons).map((s) => ({
      id: `bind:${s.id}`,
      label: truncateText(s.name || s.id.slice(0, 8), 30),
      data: s.id,
    }))
    await this.sendButtonRows(
      adapter,
      msg.channelId,
      'Recent sessions:',
      [
        ...chunkButtons(sessionButtons, 2),
        [{ id: 'menu:home', label: 'Back' }],
      ],
      replyOpts,
    )
  }

  private async sendSkillsMenu(
    adapter: PlatformAdapter,
    msg: IncomingMessage,
    page: number,
  ): Promise<void> {
    const context = await this.resolveBoundSkillContext(adapter, msg)
    if (!context) return

    let entries: SkillCommandEntry[]
    try {
      entries = buildSkillCommandEntries(
        this.skillResolver.listSkills(context.workspace.rootPath, context.session.workingDirectory),
      )
    } catch (err) {
      this.log.error('failed to list skills for interactive menu', {
        event: 'skill_menu_list_failed',
        workspaceId: context.workspace.id,
        sessionId: context.binding.sessionId,
        error: err,
      })
      await adapter.sendText(msg.channelId, 'Failed to load Craft skills for this session.', context.replyOpts)
      return
    }

    if (entries.length === 0) {
      await this.sendButtonRows(
        adapter,
        msg.channelId,
        'No Craft skills found for this session.',
        [[{ id: 'menu:home', label: 'Back' }]],
        context.replyOpts,
      )
      return
    }

    const pageCount = Math.max(1, Math.ceil(entries.length / MENU_SKILLS_PAGE_SIZE))
    const safePage = Math.min(Math.max(0, page), pageCount - 1)
    const pageEntries = entries.slice(
      safePage * MENU_SKILLS_PAGE_SIZE,
      safePage * MENU_SKILLS_PAGE_SIZE + MENU_SKILLS_PAGE_SIZE,
    )
    const nav: InlineButton[] = []
    if (safePage > 0) nav.push({ id: `menu:skills:${safePage - 1}`, label: 'Prev' })
    if (safePage + 1 < pageCount) nav.push({ id: `menu:skills:${safePage + 1}`, label: 'Next' })

    await this.sendButtonRows(
      adapter,
      msg.channelId,
      `Craft skills for "${context.session.name || context.session.id.slice(0, 8)}"\nPage ${safePage + 1}/${pageCount}. Choose a skill:`,
      [
        ...pageEntries.map((entry) => [{
          id: `menu:skill:${entry.command}`,
          label: truncateText(compactWhitespace(entry.skill.metadata.name) || entry.skill.slug, 42),
        }]),
        ...(nav.length ? [nav] : []),
        [{ id: 'menu:home', label: 'Back to Menu' }],
      ],
      context.replyOpts,
    )
    await this.syncCompactCommandMenu(adapter, msg)
  }

  private async sendSkillDetailMenu(
    adapter: PlatformAdapter,
    msg: IncomingMessage,
    command: string,
  ): Promise<void> {
    const context = await this.resolveBoundSkillContext(adapter, msg)
    if (!context) return

    const entry = this.resolveSkillEntryByCommand(context, command)
    if (!entry) {
      await this.sendButtonRows(
        adapter,
        msg.channelId,
        'Skill shortcut expired. Refresh the skills menu.',
        [
          [{ id: 'menu:skills:0', label: 'Refresh Skills' }],
          [{ id: 'menu:home', label: 'Back to Menu' }],
        ],
        context.replyOpts,
      )
      return
    }

    const name = compactWhitespace(entry.skill.metadata.name) || entry.skill.slug
    const description = compactWhitespace(entry.skill.metadata.description)
    const descriptionLine = description ? `\n${truncateText(description, 500)}` : ''
    await this.sendButtonRows(
      adapter,
      msg.channelId,
      `${name}\n${entry.skill.slug}${descriptionLine}\n\nUse this skill for your next message?`,
      [
        [{ id: `menu:use:${entry.command}`, label: 'Use Next Message' }],
        [
          { id: 'menu:skills:0', label: 'Back to Skills' },
          { id: 'menu:home', label: 'Main Menu' },
        ],
      ],
      context.replyOpts,
    )
  }

  private async armPendingSkill(
    adapter: PlatformAdapter,
    msg: IncomingMessage,
    command: string,
  ): Promise<void> {
    const context = await this.resolveBoundSkillContext(adapter, msg)
    if (!context) return

    const entry = this.resolveSkillEntryByCommand(context, command)
    if (!entry) {
      await adapter.sendText(msg.channelId, 'Skill shortcut expired. Run /menu and choose the skill again.', context.replyOpts)
      return
    }

    const skillName = compactWhitespace(entry.skill.metadata.name) || entry.skill.slug
    this.pendingSkillInvocations.set(this.pendingSkillKey(msg), {
      skillSlug: entry.skill.slug,
      skillName,
      expiresAt: Date.now() + PENDING_SKILL_TTL_MS,
    })

    await this.sendButtonRows(
      adapter,
      msg.channelId,
      `Ready. Your next text message will use "${skillName}".`,
      [[{ id: 'menu:cancel_use', label: 'Cancel' }]],
      context.replyOpts,
    )
  }

  private async sendButtonRows(
    adapter: PlatformAdapter,
    channelId: string,
    text: string,
    rows: InlineButtonRow[],
    opts: { threadId?: number },
  ): Promise<void> {
    const filteredRows = rows
      .map((row) => row.filter(Boolean))
      .filter((row) => row.length > 0)
    if (adapter.sendButtonRows) {
      await adapter.sendButtonRows(channelId, text, filteredRows, opts)
      return
    }
    await adapter.sendButtons(channelId, text, filteredRows.flat(), opts)
  }

  private messageFromButtonPress(press: ButtonPress): IncomingMessage {
    return {
      platform: press.platform,
      channelId: press.channelId,
      ...(press.threadId !== undefined ? { threadId: press.threadId } : {}),
      messageId: press.messageId,
      senderId: press.senderId,
      ...(press.senderName ? { senderName: press.senderName } : {}),
      ...(press.senderUsername ? { senderUsername: press.senderUsername } : {}),
      ...(press.senderIsBot ? { senderIsBot: true } : {}),
      text: '',
      timestamp: Date.now(),
      raw: press,
    }
  }

  private pendingSkillKey(sender: Pick<IncomingMessage, 'platform' | 'channelId' | 'threadId' | 'senderId'>): string {
    return `${sender.platform}:${sender.channelId}:${sender.threadId ?? ''}:${sender.senderId}`
  }

  private resolveSkillEntryByCommand(
    context: SkillCommandContext,
    command: string,
  ): SkillCommandEntry | null {
    if (!command) return null
    const entries = buildSkillCommandEntries(
      this.skillResolver.listSkills(context.workspace.rootPath, context.session.workingDirectory),
    )
    return entries.find((entry) => entry.command === command) ?? null
  }

  private async handleNew(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    const name = parseCommand(msg.text).args || undefined
    const replyOpts = msg.threadId !== undefined ? { threadId: msg.threadId } : {}

    try {
      const session = await this.sessionManager.createSession(this.workspaceId, { name })

      this.bindingStore.bind(
        this.workspaceId,
        session.id,
        adapter.platform,
        msg.channelId,
        msg.senderName,
        undefined,
        msg.threadId,
      )

      const displayName = session.name || session.id
      await adapter.sendText(
        msg.channelId,
        `Created "${displayName}" — you're connected. Just type to start.`,
        replyOpts,
      )
      this.log.info('session created and bound from chat', {
        event: 'session_created_from_chat',
        workspaceId: this.workspaceId,
        sessionId: session.id,
        platform: adapter.platform,
        channelId: msg.channelId,
        threadId: msg.threadId,
      })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      this.log.error('failed to create session from chat', {
        event: 'session_create_failed',
        workspaceId: this.workspaceId,
        platform: adapter.platform,
        channelId: msg.channelId,
        error: err,
      })
      await adapter.sendText(msg.channelId, `Failed to create session: ${errorMsg}`, replyOpts)
    }
  }

  private async handleBind(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    const bindArg = parseCommand(msg.text).args
    const recent = this.getRecentSessions()
    const replyOpts = msg.threadId !== undefined ? { threadId: msg.threadId } : {}

    if (bindArg) {
      const session = await this.resolveBindTarget(bindArg, recent)
      if (!session) {
        await adapter.sendText(msg.channelId, `Session not found: ${bindArg}`, replyOpts)
        return
      }

      this.bindingStore.bind(
        this.workspaceId,
        session.id,
        adapter.platform,
        msg.channelId,
        msg.senderName,
        undefined,
        msg.threadId,
      )

      this.log.info('chat bound to existing session', {
        event: 'chat_bound',
        workspaceId: this.workspaceId,
        sessionId: session.id,
        platform: adapter.platform,
        channelId: msg.channelId,
        threadId: msg.threadId,
        bindArg,
      })

      await adapter.sendText(msg.channelId, `Bound to "${session.name || session.id}"`, replyOpts)
      return
    }

    if (recent.length === 0) {
      await adapter.sendText(
        msg.channelId,
        'No sessions found. Use /new to create one.',
        replyOpts,
      )
      return
    }

    if (adapter.capabilities.inlineButtons) {
      const buttons = recent.slice(0, adapter.capabilities.maxButtons).map((s) => ({
        id: `bind:${s.id}`,
        label: (s.name || s.id.slice(0, 8)).slice(0, 30),
        data: s.id,
      }))

      await adapter.sendButtons(
        msg.channelId,
        'Recent sessions:',
        buttons,
        replyOpts,
      )
      return
    }

    const lines = recent.map((s, i) => {
      const name = s.name || s.id.slice(0, 8)
      return `${i + 1}. ${name} (${s.id.slice(0, 8)})`
    })

    await adapter.sendText(
      msg.channelId,
      'Recent sessions:\n' + lines.join('\n') + '\n\nUse /bind <number> to connect, or /bind <session-id> if you already know it.',
      replyOpts,
    )
  }

  private async handlePair(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    const replyOpts = msg.threadId !== undefined ? { threadId: msg.threadId } : {}

    if (!this.pairingConsumer) {
      await adapter.sendText(msg.channelId, 'Pairing is not available in this build.', replyOpts)
      return
    }

    // Throttle BEFORE format validation — otherwise an attacker gets
    // unlimited "is this a valid format" feedback that's almost as useful
    // as a code check. Every `/pair` attempt counts against the budget.
    if (!this.pairingConsumer.canConsume(adapter.platform, msg.senderId)) {
      this.log.warn('pairing consume rate limit hit', {
        event: 'pairing_consume_rate_limited',
        workspaceId: this.workspaceId,
        platform: adapter.platform,
        channelId: msg.channelId,
        senderId: msg.senderId,
      })
      await adapter.sendText(
        msg.channelId,
        '⏳ Too many pairing attempts. Try again in a minute.',
        replyOpts,
      )
      return
    }

    // Use the centralized parser so `/pair@MyBot 123456` works the same
    // as `/pair 123456` — Telegram routes commands by bot suffix in
    // group chats and many users will type the canonical form.
    const { args } = parseCommand(msg.text)
    const code = args.replace(/\s+/g, '')

    if (!/^\d{6}$/.test(code)) {
      await adapter.sendText(
        msg.channelId,
        'Usage: /pair <6-digit code>\n\nGenerate a code from the session menu or the Telegram supergroup setup in the Craft Agent app.',
        replyOpts,
      )
      return
    }

    // Pre-consume access gate. Bootstrap rule: when the platform has zero
    // owners, ANY successful redeem seeds the first owner (the user who
    // typed `/pair`). Once owners exist, only existing owners may redeem
    // further codes — without this, an attacker who steals or guesses a
    // code becomes an owner.
    const wsConfig = this.access.getWorkspaceConfig()
    const wsMode = readPlatformAccessMode(wsConfig, adapter.platform)
    const owners = readPlatformOwners(wsConfig, adapter.platform)
    if (
      wsMode === 'owner-only' &&
      owners.length > 0 &&
      !owners.some((o) => o.userId === msg.senderId)
    ) {
      this.log.info('pairing redeem blocked: sender is not an owner', {
        event: 'pairing_redeem_not_owner',
        workspaceId: this.workspaceId,
        platform: adapter.platform,
        senderId: msg.senderId,
      })
      await adapter.sendText(
        msg.channelId,
        'Only existing bot owners can redeem pairing codes. Ask an owner to add you in the Craft Agent app.',
        replyOpts,
      )
      return
    }

    const entry = this.pairingConsumer.consume(adapter.platform, code)
    if (!entry) {
      await adapter.sendText(msg.channelId, 'Invalid or expired pairing code.', replyOpts)
      return
    }

    // Seed the first owner. The seeder is a no-op when the list is already
    // populated, so it's safe to call unconditionally on every successful
    // redeem. Failures are logged but never block the pair itself — losing
    // the seed only means the operator has to add the user manually later.
    try {
      await this.access.seedOwnerOnFirstPair(adapter.platform, {
        userId: msg.senderId,
        ...(msg.senderName ? { displayName: msg.senderName } : {}),
        ...(msg.senderUsername ? { username: msg.senderUsername } : {}),
        addedAt: Date.now(),
      })
    } catch (err) {
      this.log.warn('seedOwnerOnFirstPair failed (non-fatal)', {
        event: 'pairing_owner_seed_failed',
        workspaceId: this.workspaceId,
        platform: adapter.platform,
        senderId: msg.senderId,
        error: err,
      })
    }

    if (entry.kind === 'workspace-supergroup') {
      await this.handleSupergroupPair(adapter, msg, entry, replyOpts)
      return
    }

    // entry.kind === 'session'
    const session = await this.sessionManager.getSession(entry.sessionId)
    if (!session) {
      await adapter.sendText(msg.channelId, 'Session no longer exists.', replyOpts)
      return
    }

    this.bindingStore.bind(
      entry.workspaceId,
      entry.sessionId,
      adapter.platform,
      msg.channelId,
      msg.senderName,
      undefined,
      msg.threadId,
    )

    this.log.info('pairing code redeemed', {
      event: 'pairing_redeemed',
      kind: 'session',
      workspaceId: entry.workspaceId,
      sessionId: entry.sessionId,
      platform: adapter.platform,
      channelId: msg.channelId,
      threadId: msg.threadId,
    })

    const topicHint = msg.threadId !== undefined
      ? ` (topic #${msg.threadId})`
      : ''
    await adapter.sendText(
      msg.channelId,
      `✅ Paired with "${session.name || session.id}"${topicHint}. You can start chatting now.`,
      replyOpts,
    )
  }

  /**
   * Workspace-supergroup pairing: a `/pair <code>` typed in a Telegram
   * supergroup with a workspace-supergroup-kind code. We register the
   * supergroup's chat_id at the workspace level so the adapter starts
   * accepting messages from it (in addition to DMs).
   */
  private async handleSupergroupPair(
    adapter: PlatformAdapter,
    msg: IncomingMessage,
    entry: { workspaceId: string },
    replyOpts: { threadId?: number },
  ): Promise<void> {
    if (adapter.platform !== 'telegram') {
      await adapter.sendText(
        msg.channelId,
        'Workspace-supergroup pairing is only supported on Telegram.',
        replyOpts,
      )
      return
    }

    if (!this.pairingConsumer?.bindWorkspaceSupergroup) {
      await adapter.sendText(
        msg.channelId,
        'Supergroup pairing is not enabled in this build.',
        replyOpts,
      )
      return
    }

    try {
      const result = await this.pairingConsumer.bindWorkspaceSupergroup({
        platform: adapter.platform,
        chatId: msg.channelId,
        fallbackTitle: msg.senderName,
      })
      this.log.info('pairing code redeemed', {
        event: 'pairing_redeemed',
        kind: 'workspace-supergroup',
        workspaceId: entry.workspaceId,
        platform: adapter.platform,
        channelId: msg.channelId,
        title: result.title,
      })
      await adapter.sendText(
        msg.channelId,
        `✅ Supergroup *${result.title}* paired. Sessions can now be bound to topics in this group.`,
        replyOpts,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      this.log.error('workspace supergroup bind failed', {
        event: 'workspace_supergroup_bind_failed',
        workspaceId: entry.workspaceId,
        platform: adapter.platform,
        channelId: msg.channelId,
        error: err,
      })
      await adapter.sendText(
        msg.channelId,
        `❌ Couldn't pair this supergroup: ${message}`,
        replyOpts,
      )
    }
  }

  private async handleUnbind(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    const replyOpts = msg.threadId !== undefined ? { threadId: msg.threadId } : {}
    const removed = this.bindingStore.unbind(adapter.platform, msg.channelId, msg.threadId)
    if (removed) {
      await adapter.sendText(msg.channelId, 'Disconnected from session.', replyOpts)
    } else {
      await adapter.sendText(msg.channelId, 'No session is bound to this chat.', replyOpts)
    }
  }

  private async handleSkills(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    const context = await this.resolveBoundSkillContext(adapter, msg)
    if (!context) return

    let skills: LoadedSkill[]
    try {
      skills = this.skillResolver.listSkills(
        context.workspace.rootPath,
        context.session.workingDirectory,
      )
    } catch (err) {
      this.log.error('failed to list skills for chat command', {
        event: 'skill_command_list_failed',
        workspaceId: context.workspace.id,
        sessionId: context.binding.sessionId,
        error: err,
      })
      await adapter.sendText(msg.channelId, 'Failed to load Craft skills for this session.', context.replyOpts)
      return
    }

    if (skills.length === 0) {
      await adapter.sendText(
        msg.channelId,
        'No Craft skills found for this session.',
        context.replyOpts,
      )
      return
    }

    const entries = buildSkillCommandEntries(skills)
    let visibleEntries = entries.slice(0, Math.min(MAX_SKILLS_IN_REPLY, entries.length))
    let text = this.formatSkillsReply(context.session, visibleEntries, entries.length)
    while (text.length > adapter.capabilities.maxMessageLength && visibleEntries.length > 5) {
      visibleEntries = visibleEntries.slice(0, -5)
      text = this.formatSkillsReply(context.session, visibleEntries, entries.length)
    }

    await adapter.sendText(msg.channelId, text, context.replyOpts)
    await this.syncCompactCommandMenu(adapter, msg)
  }

  private async handleUse(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    const { args } = parseCommand(msg.text)
    const parsed = parseSkillInvocationArgs(args)
    const replyOpts = msg.threadId !== undefined ? { threadId: msg.threadId } : {}
    if (!parsed) {
      await adapter.sendText(
        msg.channelId,
        'Usage: /use <skill-slug> <prompt>\n\nRun /skills to see available skills and shortcuts.',
        replyOpts,
      )
      return
    }

    const context = await this.resolveBoundSkillContext(adapter, msg)
    if (!context) return

    let skill: LoadedSkill | null
    try {
      skill = this.resolveSkill(context, parsed.skill)
    } catch (err) {
      this.log.error('failed to resolve skill for chat command', {
        event: 'skill_command_resolve_failed',
        workspaceId: context.workspace.id,
        sessionId: context.binding.sessionId,
        skillRef: parsed.skill,
        error: err,
      })
      await adapter.sendText(msg.channelId, 'Failed to load Craft skills for this session.', context.replyOpts)
      return
    }

    if (!skill) {
      await adapter.sendText(
        msg.channelId,
        `Skill not found: ${parsed.skill}\n\nRun /skills to see available skills.`,
        context.replyOpts,
      )
      return
    }

    await this.invokeSkill(adapter, msg, context, skill, parsed.prompt)
  }

  private async handleSkillShortcut(
    adapter: PlatformAdapter,
    msg: IncomingMessage,
    command: string,
  ): Promise<void> {
    const { args } = parseCommand(msg.text)
    const prompt = args.trim()
    const replyOpts = msg.threadId !== undefined ? { threadId: msg.threadId } : {}
    if (!prompt) {
      await adapter.sendText(
        msg.channelId,
        `Usage: /${command} <prompt>\n\nRun /skills to see skill shortcuts.`,
        replyOpts,
      )
      return
    }

    const context = await this.resolveBoundSkillContext(adapter, msg)
    if (!context) return

    let entries: SkillCommandEntry[]
    try {
      entries = buildSkillCommandEntries(
        this.skillResolver.listSkills(context.workspace.rootPath, context.session.workingDirectory),
      )
    } catch (err) {
      this.log.error('failed to resolve skill shortcut for chat command', {
        event: 'skill_shortcut_resolve_failed',
        workspaceId: context.workspace.id,
        sessionId: context.binding.sessionId,
        command,
        error: err,
      })
      await adapter.sendText(msg.channelId, 'Failed to load Craft skills for this session.', context.replyOpts)
      return
    }

    const entry = entries.find((candidate) => candidate.command === command)
    if (!entry) {
      await adapter.sendText(
        msg.channelId,
        `Unknown skill shortcut: /${command}\n\nRun /skills to refresh the available shortcuts.`,
        context.replyOpts,
      )
      return
    }

    await this.invokeSkill(adapter, msg, context, entry.skill, prompt)
  }

  private async invokeSkill(
    adapter: PlatformAdapter,
    msg: IncomingMessage,
    context: SkillCommandContext,
    skill: LoadedSkill,
    prompt: string,
  ): Promise<void> {
    try {
      this.ensureSessionCallbacks?.(context.binding.sessionId)
      await adapter.sendTyping(msg.channelId, context.replyOpts).catch(() => {})
      await this.sessionManager.sendMessage(
        context.binding.sessionId,
        prompt,
        undefined,
        undefined,
        { skillSlugs: [skill.slug] },
      )
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      this.log.error('failed to invoke skill from chat command', {
        event: 'skill_command_invoke_failed',
        workspaceId: context.workspace.id,
        sessionId: context.binding.sessionId,
        skillSlug: skill.slug,
        error: err,
      })
      await adapter.sendText(
        msg.channelId,
        `Failed to start skill run: ${errorMsg}`,
        context.replyOpts,
      )
    }
  }

  private resolveSkill(context: SkillCommandContext, skillRef: string): LoadedSkill | null {
    const direct = this.skillResolver.loadSkill(
      context.workspace.rootPath,
      skillRef,
      context.session.workingDirectory,
    )
    if (direct) return direct

    const normalized = skillRef.toLowerCase()
    return this.skillResolver
      .listSkills(context.workspace.rootPath, context.session.workingDirectory)
      .find((skill) =>
        skill.slug.toLowerCase() === normalized ||
        skill.metadata.name.toLowerCase() === normalized
      ) ?? null
  }

  private async resolveBoundSkillContext(
    adapter: PlatformAdapter,
    msg: IncomingMessage,
  ): Promise<SkillCommandContext | null> {
    const replyOpts = msg.threadId !== undefined ? { threadId: msg.threadId } : {}
    const binding = this.bindingStore.findByChannel(adapter.platform, msg.channelId, msg.threadId)
    if (!binding) {
      await adapter.sendText(
        msg.channelId,
        'No session bound. Use /bind, /new, or /pair first.',
        replyOpts,
      )
      return null
    }

    const verdict = evaluateBindingAccess({
      msg,
      workspaceConfig: this.access.getWorkspaceConfig(),
      binding,
    })
    if (!verdict.allow) {
      await this.sendRejection(adapter, msg, verdict.reason, {
        bindingId: binding.id,
        sessionId: binding.sessionId,
      })
      return null
    }

    const session = await this.sessionManager.getSession(binding.sessionId)
    if (!session) {
      await adapter.sendText(msg.channelId, 'Session no longer exists.', replyOpts)
      return null
    }

    const workspace = this.resolveWorkspaceForSession(session, binding)
    if (!workspace) {
      await adapter.sendText(
        msg.channelId,
        'Workspace not found for this session.',
        replyOpts,
      )
      return null
    }

    return { binding, session, workspace, replyOpts }
  }

  private resolveWorkspaceForSession(
    session: Session,
    binding: ChannelBinding,
  ): Workspace | null {
    const getWorkspaces = (this.sessionManager as Partial<Pick<ISessionManager, 'getWorkspaces'>>).getWorkspaces
    if (typeof getWorkspaces !== 'function') return null
    const workspaceId = session.workspaceId || binding.workspaceId || this.workspaceId
    return getWorkspaces.call(this.sessionManager).find((workspace) => workspace.id === workspaceId) ?? null
  }

  private formatSkillsReply(
    session: Session,
    entries: SkillCommandEntry[],
    total: number,
  ): string {
    const sessionName = session.name || session.id.slice(0, 8)
    const lines = entries.map((entry) => {
      const name = truncateText(compactWhitespace(entry.skill.metadata.name) || entry.skill.slug, 48)
      const description = truncateText(compactWhitespace(entry.skill.metadata.description), 90)
      const suffix = description ? `: ${description}` : ''
      return `- ${name} (${entry.skill.slug})${suffix}`
    })
    const more = total > entries.length
      ? `\n... ${total - entries.length} more skills hidden. Use /menu for the paged skill picker.`
      : ''

    return [
      `Craft skills for "${sessionName}" (${total}):`,
      lines.join('\n'),
      more,
      '',
      'Use /menu for buttons, or /use <skill-slug> <prompt> if you prefer text commands.',
    ].filter(Boolean).join('\n')
  }

  private async syncCompactCommandMenu(
    adapter: PlatformAdapter,
    msg: IncomingMessage,
  ): Promise<void> {
    if (!adapter.setCommandMenu) return

    try {
      await adapter.setCommandMenu(
        BASE_COMMAND_MENU,
        { channelId: msg.channelId },
      )
      this.log.info('chat command menu synced with skills', {
        event: 'compact_command_menu_synced',
        platform: adapter.platform,
        channelId: msg.channelId,
        commandCount: BASE_COMMAND_MENU.length,
      })
    } catch (err) {
      this.log.warn('failed to sync compact chat command menu', {
        event: 'compact_command_menu_sync_failed',
        platform: adapter.platform,
        channelId: msg.channelId,
        error: err,
      })
    }
  }

  private async handleStatus(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    const replyOpts = msg.threadId !== undefined ? { threadId: msg.threadId } : {}
    const binding = this.bindingStore.findByChannel(adapter.platform, msg.channelId, msg.threadId)
    if (!binding) {
      await adapter.sendText(msg.channelId, 'No session bound. Use /bind, /new, or /pair.', replyOpts)
      return
    }

    const session = await this.sessionManager.getSession(binding.sessionId)
    const name = session?.name || binding.sessionId.slice(0, 8)
    const mode = binding.config.approvalChannel
    const responseMode = binding.config.responseMode

    await adapter.sendText(
      msg.channelId,
      `Bound to "${name}"\nApproval: ${mode}\nResponse mode: ${responseMode}`,
      replyOpts,
    )
  }

  private async handleStop(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    const replyOpts = msg.threadId !== undefined ? { threadId: msg.threadId } : {}
    const binding = this.bindingStore.findByChannel(adapter.platform, msg.channelId, msg.threadId)
    if (!binding) {
      await adapter.sendText(msg.channelId, 'No session bound.', replyOpts)
      return
    }

    try {
      await this.sessionManager.cancelProcessing(binding.sessionId)
      await adapter.sendText(msg.channelId, 'Stopped.', replyOpts)
    } catch {
      await adapter.sendText(msg.channelId, 'Nothing to stop.', replyOpts)
    }
  }

  private async handleHelp(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    const bindLine = adapter.platform === 'whatsapp' || adapter.platform === 'weixin'
      ? '/bind — list recent sessions (then use /bind <number>)\n'
      : '/bind — pick from recent sessions\n'
    const replyOpts = msg.threadId !== undefined ? { threadId: msg.threadId } : {}

    await adapter.sendText(
      msg.channelId,
      'Commands:\n' +
      '/new [name] — create + bind new session\n' +
      bindLine +
      '/bind <id> — bind to specific session\n' +
      '/pair <code> — redeem an app-generated pairing code\n' +
      '/menu — open interactive menu\n' +
      '/skills — list Craft skills for this session\n' +
      '/use <skill> <prompt> — run with a Craft skill\n' +
      '/unbind — disconnect this chat\n' +
      '/status — show current binding\n' +
      '/stop — abort current agent run\n' +
      '/help — show this message',
      replyOpts,
    )
  }

  private getRecentSessions(): ReturnType<ISessionManager['getSessions']> {
    return this.sessionManager.getSessions(this.workspaceId)
      .filter((s) => !s.isArchived)
      .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
      .slice(0, 10)
  }

  private async resolveBindTarget(
    bindArg: string,
    recent: ReturnType<ISessionManager['getSessions']>,
  ): Promise<Awaited<ReturnType<ISessionManager['getSession']>> | undefined> {
    if (/^\d+$/.test(bindArg)) {
      const index = Number(bindArg)
      if (index >= 1 && index <= recent.length) {
        return recent[index - 1]
      }
    }
    return this.sessionManager.getSession(bindArg)
  }
}
