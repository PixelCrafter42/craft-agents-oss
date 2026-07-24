import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Workspace } from '@craft-agent/core/types'
import type { SendMessageOptions, Session } from '@craft-agent/shared/protocol'
import type { LoadedSkill } from '@craft-agent/shared/skills'
import type { ISessionManager } from '@craft-agent/server-core/handlers'
import { BindingStore } from '../binding-store'
import { Commands } from '../commands'
import type { ButtonPress, CommandMenuOptions, IncomingMessage, InlineButtonRow, PlatformAdapter, PlatformCommand, PlatformType, SentMessage } from '../types'

function makeSession(id: string, name: string, lastMessageAt: number): Session {
  return {
    id,
    name,
    workspaceId: 'ws1',
    workspaceName: 'Workspace',
    messages: [],
    createdAt: lastMessageAt - 1000,
    updatedAt: lastMessageAt,
    lastMessageAt,
    isArchived: false,
  } as unknown as Session
}

interface CapturedSessionMessage {
  sessionId: string
  message: string
  options?: SendMessageOptions
}

function makeSessionManager(
  sessions: Session[],
  created?: Session,
  sentMessages: CapturedSessionMessage[] = [],
): ISessionManager {
  const workspaces: Workspace[] = [{
    id: 'ws1',
    name: 'Workspace',
    slug: 'workspace',
    rootPath: '/tmp/workspace',
    createdAt: 0,
  }]
  return {
    getSessions: () => sessions,
    getSession: async (sessionId: string) => sessions.find((session) => session.id === sessionId) ?? null,
    getWorkspaces: () => workspaces,
    createSession: async (_workspaceId: string, options?: { name?: string }) => {
      if (!created) throw new Error('not implemented')
      return { ...created, name: options?.name ?? created.name }
    },
    sendMessage: async (
      sessionId: string,
      message: string,
      _attachments?: unknown,
      _storedAttachments?: unknown,
      options?: SendMessageOptions,
    ) => {
      sentMessages.push({ sessionId, message, options })
    },
    cancelProcessing: async () => {},
    respondToPermission: () => true,
  } as unknown as ISessionManager
}

function makeAdapter(
  platform: PlatformType,
  inlineButtons: boolean,
): PlatformAdapter & {
  sent: string[]
  buttonRows: { text: string; rows: InlineButtonRow[] }[]
  commandMenus: { commands: PlatformCommand[]; opts?: CommandMenuOptions }[]
} {
  const sent: string[] = []
  const buttonRows: { text: string; rows: InlineButtonRow[] }[] = []
  const commandMenus: { commands: PlatformCommand[]; opts?: CommandMenuOptions }[] = []
  return {
    platform,
    capabilities: {
      messageEditing: inlineButtons,
      inlineButtons,
      maxButtons: 10,
      maxMessageLength: 4096,
      markdown: platform === 'telegram' ? 'v2' : 'whatsapp',
      webhookSupport: false,
    },
    sent,
    buttonRows,
    commandMenus,
    async initialize() {},
    async destroy() {},
    isConnected() { return true },
    onMessage() {},
    onButtonPress() {},
    async sendText(_channelId: string, text: string): Promise<SentMessage> {
      sent.push(text)
      return { platform, channelId: 'chan-1', messageId: String(sent.length) }
    },
    async editMessage() {},
    async sendButtons(_channelId: string, text: string): Promise<SentMessage> {
      sent.push(text)
      return { platform, channelId: 'chan-1', messageId: String(sent.length) }
    },
    async sendButtonRows(_channelId: string, text: string, rows: InlineButtonRow[]): Promise<SentMessage> {
      sent.push(text)
      buttonRows.push({ text, rows })
      return { platform, channelId: 'chan-1', messageId: String(sent.length) }
    },
    async sendTyping() {},
    async sendFile(): Promise<SentMessage> {
      return { platform, channelId: 'chan-1', messageId: String(sent.length + 1) }
    },
    async setCommandMenu(commands: PlatformCommand[], opts?: CommandMenuOptions): Promise<void> {
      commandMenus.push({ commands, opts })
    },
  }
}

function makeSkill(slug: string, name: string, description = 'Skill description'): LoadedSkill {
  return {
    slug,
    metadata: { name, description },
    content: '',
    path: `/tmp/workspace/skills/${slug}`,
    source: 'workspace',
  }
}

function makeMessage(text: string, platform: PlatformType = 'whatsapp'): IncomingMessage {
  return {
    platform,
    channelId: 'chan-1',
    messageId: 'm1',
    senderId: 'u1',
    senderName: 'Alice',
    text,
    timestamp: Date.now(),
    raw: {},
  }
}

function makePress(buttonId: string): ButtonPress {
  return {
    platform: 'telegram',
    channelId: 'chan-1',
    messageId: 'button-message-1',
    senderId: 'u1',
    senderName: 'Alice',
    buttonId,
    data: buttonId,
  }
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeStore(): BindingStore {
  const dir = mkdtempSync(join(tmpdir(), 'commands-bind-'))
  tempDirs.push(dir)
  return new BindingStore(dir)
}

describe('Commands', () => {
  it('binds by numbered recent-session index on non-inline platforms', async () => {
    const sessions = [
      makeSession('sess-1', 'Old', 100),
      makeSession('sess-2', 'Newest', 200),
    ]
    const store = makeStore()
    const commands = new Commands(makeSessionManager(sessions), store, 'ws1')
    const adapter = makeAdapter('whatsapp', false)

    await commands.handleCommand(adapter, makeMessage('/bind 1'))

    expect(store.findByChannel('whatsapp', 'chan-1')?.sessionId).toBe('sess-2')
    expect(adapter.sent.at(-1)).toContain('Newest')
  })

  it('lists numbered recent sessions with usable /bind instructions on WhatsApp', async () => {
    const sessions = [
      makeSession('sess-1', 'Alpha', 100),
      makeSession('sess-2', 'Beta', 200),
    ]
    const store = makeStore()
    const commands = new Commands(makeSessionManager(sessions), store, 'ws1')
    const adapter = makeAdapter('whatsapp', false)

    await commands.handleCommand(adapter, makeMessage('/bind'))

    expect(adapter.sent[0]).toContain('1. Beta (sess-2)')
    expect(adapter.sent[0]).toContain('/bind <number>')
  })

  it('creates and binds a new WeChat session with /new', async () => {
    const created = makeSession('sess-new', 'Created from WeChat', 300)
    const store = makeStore()
    const commands = new Commands(makeSessionManager([], created), store, 'ws1')
    const adapter = makeAdapter('weixin', false)

    await commands.handleCommand(adapter, makeMessage('/new WeChat project', 'weixin'))

    expect(store.findByChannel('weixin', 'chan-1')?.sessionId).toBe('sess-new')
    expect(store.findByChannel('weixin', 'chan-1')?.config.approvalChannel).toBe('app')
    expect(adapter.sent.at(-1)).toContain('WeChat project')
  })

  it('lists numbered recent sessions with usable /bind instructions on WeChat', async () => {
    const sessions = [
      makeSession('sess-1', 'Alpha', 100),
      makeSession('sess-2', 'Beta', 200),
    ]
    const store = makeStore()
    const commands = new Commands(makeSessionManager(sessions), store, 'ws1')
    const adapter = makeAdapter('weixin', false)

    await commands.handleCommand(adapter, makeMessage('/bind', 'weixin'))

    expect(adapter.sent[0]).toContain('1. Beta (sess-2)')
    expect(adapter.sent[0]).toContain('/bind <number>')
  })

  it('lists Craft skills and keeps Telegram autocomplete minimal', async () => {
    const sessions = [makeSession('sess-1', 'Telegram session', 100)]
    const skills = [
      makeSkill('browser:control-chrome', 'Chrome control', 'Operate the user browser'),
      makeSkill('review-code', 'Code review', 'Review a pull request'),
    ]
    const store = makeStore()
    store.bind('ws1', 'sess-1', 'telegram', 'chan-1')
    const commands = new Commands(
      makeSessionManager(sessions),
      store,
      'ws1',
      undefined,
      undefined,
      undefined,
      {
        skillResolver: {
          listSkills: () => skills,
          loadSkill: (_workspaceRoot, slug) => skills.find((skill) => skill.slug === slug) ?? null,
        },
      },
    )
    const adapter = makeAdapter('telegram', true)

    await commands.handleCommand(adapter, makeMessage('/skills', 'telegram'))

    expect(adapter.sent[0]).toContain('Craft skills for "Telegram session" (2):')
    expect(adapter.sent[0]).toContain('- Chrome control (browser:control-chrome)')
    expect(adapter.sent[0]).toContain('- Code review (review-code)')
    expect(adapter.sent[0]).not.toContain('/s_browser_control_chrome')
    expect(adapter.sent[0]).toContain('/use <skill-slug> <prompt>')
    expect(adapter.commandMenus).toHaveLength(1)
    expect(adapter.commandMenus[0]?.opts).toEqual({ channelId: 'chan-1' })
    expect(adapter.commandMenus[0]?.commands.map((command) => command.command)).toEqual(['menu', 'pair'])
  })

  it('invokes a Craft skill with /use', async () => {
    const sessions = [makeSession('sess-1', 'Telegram session', 100)]
    const sentMessages: CapturedSessionMessage[] = []
    const skills = [makeSkill('browser:control-chrome', 'Chrome control')]
    const store = makeStore()
    store.bind('ws1', 'sess-1', 'telegram', 'chan-1')
    const commands = new Commands(
      makeSessionManager(sessions, undefined, sentMessages),
      store,
      'ws1',
      undefined,
      undefined,
      undefined,
      {
        skillResolver: {
          listSkills: () => skills,
          loadSkill: (_workspaceRoot, slug) => skills.find((skill) => skill.slug === slug) ?? null,
        },
      },
    )
    const adapter = makeAdapter('telegram', true)

    await commands.handleCommand(
      adapter,
      makeMessage('/use browser:control-chrome open the docs', 'telegram'),
    )

    expect(sentMessages).toEqual([{
      sessionId: 'sess-1',
      message: 'open the docs',
      options: { skillSlugs: ['browser:control-chrome'] },
    }])
    expect(adapter.sent).toEqual([])
  })

  it('invokes a Craft skill with a dynamic shortcut command', async () => {
    const sessions = [makeSession('sess-1', 'Telegram session', 100)]
    const sentMessages: CapturedSessionMessage[] = []
    const skills = [makeSkill('browser:control-chrome', 'Chrome control')]
    const store = makeStore()
    store.bind('ws1', 'sess-1', 'telegram', 'chan-1')
    const commands = new Commands(
      makeSessionManager(sessions, undefined, sentMessages),
      store,
      'ws1',
      undefined,
      undefined,
      undefined,
      {
        skillResolver: {
          listSkills: () => skills,
          loadSkill: (_workspaceRoot, slug) => skills.find((skill) => skill.slug === slug) ?? null,
        },
      },
    )
    const adapter = makeAdapter('telegram', true)

    await commands.handleCommand(
      adapter,
      makeMessage('/s_browser_control_chrome open the docs', 'telegram'),
    )

    expect(sentMessages).toEqual([{
      sessionId: 'sess-1',
      message: 'open the docs',
      options: { skillSlugs: ['browser:control-chrome'] },
    }])
    expect(adapter.sent).toEqual([])
  })

  it('shows an interactive Telegram-style menu with button rows', async () => {
    const sessions = [makeSession('sess-1', 'Telegram session', 100)]
    const store = makeStore()
    store.bind('ws1', 'sess-1', 'telegram', 'chan-1')
    const commands = new Commands(makeSessionManager(sessions), store, 'ws1')
    const adapter = makeAdapter('telegram', true)

    await commands.handleCommand(adapter, makeMessage('/menu', 'telegram'))

    expect(adapter.buttonRows).toHaveLength(1)
    expect(adapter.buttonRows[0]?.text).toContain('Craft Agents Menu')
    expect(adapter.buttonRows[0]?.rows[0]?.map((button) => button.label)).toEqual(['Skills', 'Status'])
    expect(adapter.buttonRows[0]?.rows[1]?.map((button) => button.label)).toEqual(['Sessions', 'Stop'])
    expect(adapter.commandMenus).toHaveLength(1)
    expect(adapter.commandMenus[0]?.opts).toEqual({ channelId: 'chan-1' })
    expect(adapter.commandMenus[0]?.commands.map((command) => command.command)).toEqual(['menu', 'pair'])
  })

  it('shows the bound session context percentage in /status', async () => {
    const session = makeSession('sess-1', 'Context session', 100)
    session.tokenUsage = {
      inputTokens: 124_000,
      outputTokens: 0,
      totalTokens: 124_000,
      contextTokens: 124_000,
      costUsd: 0,
      contextWindow: 200_000,
    }
    const store = makeStore()
    store.bind('ws1', 'sess-1', 'telegram', 'chan-1')
    const commands = new Commands(makeSessionManager([session]), store, 'ws1')
    const adapter = makeAdapter('telegram', true)

    await commands.handleCommand(adapter, makeMessage('/status', 'telegram'))

    expect(adapter.sent.at(-1)).toContain('Bound to "Context session"')
    expect(adapter.sent.at(-1)).toContain('Context: 62%')
  })

  it('makes missing context measurements explicit in /status', async () => {
    const session = makeSession('sess-1', 'New session', 100)
    const store = makeStore()
    store.bind('ws1', 'sess-1', 'whatsapp', 'chan-1')
    const commands = new Commands(makeSessionManager([session]), store, 'ws1')
    const adapter = makeAdapter('whatsapp', false)

    await commands.handleCommand(adapter, makeMessage('/status'))

    expect(adapter.sent.at(-1)).toContain('Context: unavailable')
  })

  it('opens a skill detail menu from an inline menu button and uses the next text message with that skill', async () => {
    const sessions = [makeSession('sess-1', 'Telegram session', 100)]
    const sentMessages: CapturedSessionMessage[] = []
    const skills = [makeSkill('browser:control-chrome', 'Chrome control')]
    const store = makeStore()
    store.bind('ws1', 'sess-1', 'telegram', 'chan-1')
    const commands = new Commands(
      makeSessionManager(sessions, undefined, sentMessages),
      store,
      'ws1',
      undefined,
      undefined,
      undefined,
      {
        skillResolver: {
          listSkills: () => skills,
          loadSkill: (_workspaceRoot, slug) => skills.find((skill) => skill.slug === slug) ?? null,
        },
      },
    )
    const adapter = makeAdapter('telegram', true)

    await commands.handleMenuButton(adapter, makePress('menu:skills:0'))
    expect(adapter.buttonRows.at(-1)?.rows.some((row) =>
      row.some((button) => button.id === 'menu:skill:s_browser_control_chrome')
    )).toBe(true)

    await commands.handleMenuButton(adapter, makePress('menu:skill:s_browser_control_chrome'))
    expect(adapter.buttonRows.at(-1)?.text).toContain('Chrome control')
    expect(adapter.buttonRows.at(-1)?.rows[0]?.[0]?.id).toBe('menu:use:s_browser_control_chrome')

    await commands.handleMenuButton(adapter, makePress('menu:use:s_browser_control_chrome'))
    expect(adapter.sent.at(-1)).toContain('Your next text message will use "Chrome control"')

    const consumed = await commands.consumePendingSkill(
      adapter,
      makeMessage('open the docs', 'telegram'),
    )

    expect(consumed).toBe(true)
    expect(sentMessages).toEqual([{
      sessionId: 'sess-1',
      message: 'open the docs',
      options: { skillSlugs: ['browser:control-chrome'] },
    }])
  })
})
