/**
 * MessagingGatewayRegistry.bindAutomationSession tests
 *
 * Covers the glue between the automation flow and Phase A's topic infra:
 *   - invalid-name (empty / whitespace / >128 chars)
 *   - no-supergroup (no supergroup paired)
 *   - no-adapter (supergroup paired but Telegram adapter not registered)
 *   - topic-create-failed (createForumTopic throws)
 *   - success path: creates topic, persists binding, returns reused=false
 *   - second success: reused=true, no second createForumTopic call
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type {
  CredentialManager,
} from '@craft-agent/shared/credentials'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { ISessionManager } from '@craft-agent/server-core/handlers'

import { MessagingGatewayRegistry } from '../registry'
import type { TelegramChatInfo } from '../adapters/telegram/index'
import type { PlatformAdapter, PlatformType } from '../types'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reg-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeStubSessionManager(): ISessionManager {
  return {
    setAutomationBinder: () => {},
  } as unknown as ISessionManager
}

function makeStubCredentialManager(): CredentialManager {
  return {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
  } as unknown as CredentialManager
}

interface FakeAdapterOptions {
  shouldFailCreate?: boolean
  failMessage?: string
  /** Override the result of `getChatInfo`. Defaults to a forum supergroup. */
  chatInfo?: TelegramChatInfo | null
}

function makeFakeTelegramAdapter(opts: FakeAdapterOptions = {}): {
  adapter: PlatformAdapter
  createCalls: Array<{ chatId: string; name: string }>
} {
  const createCalls: Array<{ chatId: string; name: string }> = []
  let nextThreadId = 100

  const defaultChatInfo: TelegramChatInfo = {
    type: 'supergroup',
    isForum: true,
    title: 'Test Forum SG',
  }

  const adapter: PlatformAdapter = {
    platform: 'telegram' as PlatformType,
    capabilities: {} as PlatformAdapter['capabilities'],
    initialize: async () => {},
    destroy: async () => {},
    isConnected: () => true,
    onMessage: () => {},
    onButtonPress: () => {},
    sendText: async () => ({ messageId: '1' }),
    editMessage: async () => {},
    sendButtons: async () => ({ messageId: '1' }),
    sendTyping: async () => {},
    sendFile: async () => ({ messageId: '1' }),
    createForumTopic: async (chatId: string, name: string) => {
      createCalls.push({ chatId, name })
      if (opts.shouldFailCreate) {
        throw new Error(opts.failMessage ?? 'permission denied')
      }
      return { threadId: nextThreadId++, name }
    },
    getChatInfo: async () =>
      opts.chatInfo === null ? null : opts.chatInfo ?? defaultChatInfo,
    setAcceptedSupergroupChatId: () => {},
  } as unknown as PlatformAdapter

  return { adapter, createCalls }
}

function makeFakeMessagingAdapter(platform: PlatformType): {
  adapter: PlatformAdapter
  sentTexts: Array<{ channelId: string; text: string }>
} {
  const sentTexts: Array<{ channelId: string; text: string }> = []
  const adapter: PlatformAdapter = {
    platform,
    capabilities: {
      messageEditing: false,
      inlineButtons: false,
      maxButtons: 0,
      maxMessageLength: 4096,
      markdown: 'whatsapp',
      webhookSupport: false,
    },
    initialize: async () => {},
    destroy: async () => {},
    isConnected: () => true,
    onMessage: () => {},
    onButtonPress: () => {},
    sendText: async (channelId: string, text: string) => {
      sentTexts.push({ channelId, text })
      return { platform, channelId, messageId: String(sentTexts.length) }
    },
    editMessage: async () => {},
    sendButtons: async (channelId: string, text: string) => {
      sentTexts.push({ channelId, text })
      return { platform, channelId, messageId: String(sentTexts.length) }
    },
    sendTyping: async () => {},
    sendFile: async (channelId: string) => ({ platform, channelId, messageId: 'file-1' }),
  }
  return { adapter, sentTexts }
}

interface Harness {
  registry: MessagingGatewayRegistry
  workspaceId: string
}

function makeRegistry(): Harness {
  const registry = new MessagingGatewayRegistry({
    sessionManager: makeStubSessionManager(),
    credentialManager: makeStubCredentialManager(),
    getMessagingDir: (workspaceId: string) => join(dir, 'workspaces', workspaceId, 'messaging'),
    whatsapp: { workerEntry: '/dev/null' },
  })
  return { registry, workspaceId: 'ws-test' }
}

describe('MessagingGatewayRegistry binding lookup provider', () => {
  it('serves live bindings before initialization without preventing later gateway startup', async () => {
    let lookup: ((workspaceId: string) => Array<{ id: string; sessionId: string }>) | undefined
    const sessionManager = {
      setAutomationBinder: () => {},
      setMessagingBindingLookup: (fn: typeof lookup) => { lookup = fn },
    } as unknown as ISessionManager
    const registry = new MessagingGatewayRegistry({
      sessionManager,
      credentialManager: makeStubCredentialManager(),
      getMessagingDir: (workspaceId: string) => join(dir, 'workspaces', workspaceId, 'messaging'),
      whatsapp: { workerEntry: '/dev/null' },
    })
    const workspaceId = 'ws-early-lookup'

    // The lookup bootstraps the persisted store before initializeWorkspace.
    expect(lookup?.(workspaceId)).toEqual([])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = (registry as any).workspaces.get(workspaceId)
    state.gateway.getBindingStore().bind(
      workspaceId,
      'telegram-session',
      'telegram',
      'chat-1',
      'Telegram chat',
    )
    expect(lookup?.(workspaceId)).toEqual([
      expect.objectContaining({ sessionId: 'telegram-session', id: expect.any(String) }),
    ])

    await registry.updateConfig(workspaceId, {
      enabled: true,
      platforms: {},
    })
    let starts = 0
    let releaseStart!: () => void
    state.gateway.start = async () => {
      starts += 1
      await new Promise<void>((resolve) => { releaseStart = resolve })
    }

    const first = registry.initializeWorkspace(workspaceId)
    const concurrent = registry.initializeWorkspace(workspaceId)
    await Promise.resolve()
    expect(starts).toBe(1)
    releaseStart()
    await Promise.all([first, concurrent])
    await registry.initializeWorkspace(workspaceId)

    expect(starts).toBe(1)
  })
})

/**
 * Pair a supergroup at the workspace level by writing the config directly.
 * `bindWorkspaceSupergroup` requires a real adapter and an API call; for
 * unit tests we sidestep that by using updateConfig.
 */
async function pairSupergroup(harness: Harness, chatId = '-100123', title = 'Test SG') {
  await harness.registry.updateConfig(harness.workspaceId, {
    enabled: true,
    platforms: {
      telegram: {
        enabled: true,
        supergroup: { chatId, title, capturedAt: Date.now() },
      },
    } as never,
  })
}

/**
 * Reach into the registry via getConfig + reflective access on the workspace
 * state to inject a fake adapter. The registry exposes its gateways only
 * indirectly; for tests we read the private map.
 */
function injectAdapter(harness: Harness, adapter: PlatformAdapter): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = (harness.registry as any).workspaces.get(harness.workspaceId)
  if (!state) throw new Error('workspace state missing — call pairSupergroup first')
  state.gateway.registerAdapter(adapter)
}

describe('MessagingGatewayRegistry.bindAutomationSession', () => {
  it('returns invalid-name for empty / whitespace / overlong topic names', async () => {
    const h = makeRegistry()
    await pairSupergroup(h)

    for (const name of ['', '   ', '\t', 'x'.repeat(129)]) {
      const result = await h.registry.bindAutomationSession({
        workspaceId: h.workspaceId,
        sessionId: 's1',
        topicName: name,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('invalid-name')
    }
  })

  it('returns no-supergroup when no supergroup is paired', async () => {
    const h = makeRegistry()
    const result = await h.registry.bindAutomationSession({
      workspaceId: h.workspaceId,
      sessionId: 's1',
      topicName: 'Reports',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('no-supergroup')
  })

  it('returns no-adapter when supergroup paired but adapter not registered', async () => {
    const h = makeRegistry()
    await pairSupergroup(h)
    const result = await h.registry.bindAutomationSession({
      workspaceId: h.workspaceId,
      sessionId: 's1',
      topicName: 'Reports',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('no-adapter')
  })

  it('returns topic-create-failed when createForumTopic throws', async () => {
    const h = makeRegistry()
    await pairSupergroup(h)
    const { adapter } = makeFakeTelegramAdapter({
      shouldFailCreate: true,
      failMessage: 'Bot lacks Manage Topics',
    })
    injectAdapter(h, adapter)

    const result = await h.registry.bindAutomationSession({
      workspaceId: h.workspaceId,
      sessionId: 's1',
      topicName: 'Reports',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('topic-create-failed')
      expect(result.error).toContain('Manage Topics')
    }
  })

  it('creates a new topic on first call and reuses it on the second', async () => {
    const h = makeRegistry()
    await pairSupergroup(h, '-100999')
    const { adapter, createCalls } = makeFakeTelegramAdapter()
    injectAdapter(h, adapter)

    const first = await h.registry.bindAutomationSession({
      workspaceId: h.workspaceId,
      sessionId: 's1',
      topicName: 'Daily Digest',
    })
    expect(first.ok).toBe(true)
    if (first.ok) {
      expect(first.chatId).toBe('-100999')
      expect(first.threadId).toBe(100)
      expect(first.reused).toBe(false)
    }
    expect(createCalls.length).toBe(1)
    expect(createCalls[0]).toEqual({ chatId: '-100999', name: 'Daily Digest' })

    const second = await h.registry.bindAutomationSession({
      workspaceId: h.workspaceId,
      sessionId: 's2',
      topicName: 'Daily Digest',
    })
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(second.threadId).toBe(100)
      expect(second.reused).toBe(true)
    }
    expect(createCalls.length).toBe(1)
  })

  it('records a binding in the BindingStore on success', async () => {
    const h = makeRegistry()
    await pairSupergroup(h, '-100777', 'My SG')
    const { adapter } = makeFakeTelegramAdapter()
    injectAdapter(h, adapter)

    const result = await h.registry.bindAutomationSession({
      workspaceId: h.workspaceId,
      sessionId: 'sess-X',
      topicName: 'Errors',
    })
    expect(result.ok).toBe(true)

    const bindings = h.registry.getBindings(h.workspaceId)
    expect(bindings.length).toBe(1)
    const binding = bindings[0]!
    expect(binding.sessionId).toBe('sess-X')
    expect(binding.platform).toBe('telegram')
    expect(binding.channelId).toBe('-100777')
    expect(binding.threadId).toBe(100)
  })
})

describe('MessagingGatewayRegistry.bindAutomationMessagingTarget', () => {
  it('renders automation session output to Weixin without mutating persisted bindings', async () => {
    const h = makeRegistry()
    await h.registry.updateConfig(h.workspaceId, {
      enabled: true,
      platforms: {
        weixin: { enabled: true },
      } as never,
    })
    const { adapter, sentTexts } = makeFakeMessagingAdapter('weixin')
    injectAdapter(h, adapter)

    const result = await h.registry.bindAutomationMessagingTarget({
      workspaceId: h.workspaceId,
      sessionId: 'auto-s1',
      target: {
        platform: 'weixin',
        channelId: 'wx-user-1',
      },
    })

    expect(result.ok).toBe(true)
    expect(h.registry.getBindings(h.workspaceId)).toHaveLength(0)

    h.registry.onSessionEvent(
      RPC_CHANNELS.sessions.EVENT,
      { to: 'workspace', workspaceId: h.workspaceId },
      { type: 'text_complete', sessionId: 'auto-s1', text: 'Daily summary' },
    )
    h.registry.onSessionEvent(
      RPC_CHANNELS.sessions.EVENT,
      { to: 'workspace', workspaceId: h.workspaceId },
      { type: 'complete', sessionId: 'auto-s1' },
    )

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sentTexts).toEqual([{ channelId: 'wx-user-1', text: 'Daily summary' }])
  })

  it('copies an existing binding target by bindingId for output-only routing', async () => {
    const h = makeRegistry()
    await h.registry.updateConfig(h.workspaceId, {
      enabled: true,
      platforms: {
        weixin: { enabled: true },
      } as never,
    })
    const { adapter, sentTexts } = makeFakeMessagingAdapter('weixin')
    injectAdapter(h, adapter)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = (h.registry as any).workspaces.get(h.workspaceId)
    const existing = state.gateway.getBindingStore().bind(
      h.workspaceId,
      'interactive-s1',
      'weixin',
      'wx-existing',
      'Weixin User',
    )

    const result = await h.registry.bindAutomationMessagingTarget({
      workspaceId: h.workspaceId,
      sessionId: 'auto-s2',
      target: { bindingId: existing.id },
    })

    expect(result.ok).toBe(true)
    expect(h.registry.getBindings(h.workspaceId)).toHaveLength(1)
    expect(h.registry.getBindings(h.workspaceId)[0]!.sessionId).toBe('interactive-s1')

    h.registry.onSessionEvent(
      RPC_CHANNELS.sessions.EVENT,
      { to: 'workspace', workspaceId: h.workspaceId },
      { type: 'text_complete', sessionId: 'auto-s2', text: 'Copied target summary' },
    )
    h.registry.onSessionEvent(
      RPC_CHANNELS.sessions.EVENT,
      { to: 'workspace', workspaceId: h.workspaceId },
      { type: 'complete', sessionId: 'auto-s2' },
    )

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sentTexts).toEqual([{ channelId: 'wx-existing', text: 'Copied target summary' }])
  })

  it('auto-resolves a platform-only target to the latest enabled binding', async () => {
    const h = makeRegistry()
    await h.registry.updateConfig(h.workspaceId, {
      enabled: true,
      platforms: {
        weixin: { enabled: true },
      } as never,
    })
    const { adapter, sentTexts } = makeFakeMessagingAdapter('weixin')
    injectAdapter(h, adapter)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = (h.registry as any).workspaces.get(h.workspaceId)
    state.gateway.getBindingStore().bind(
      h.workspaceId,
      'older-interactive',
      'weixin',
      'wx-older',
      'Older Weixin User',
    )
    await new Promise((resolve) => setTimeout(resolve, 1))
    const latest = state.gateway.getBindingStore().bind(
      h.workspaceId,
      'latest-interactive',
      'weixin',
      'wx-latest',
      'Latest Weixin User',
    )

    const result = await h.registry.bindAutomationMessagingTarget({
      workspaceId: h.workspaceId,
      sessionId: 'auto-s3',
      target: { platform: 'weixin' },
    })

    expect(result).toMatchObject({
      ok: true,
      platform: 'weixin',
      channelId: 'wx-latest',
      sourceBindingId: latest.id,
    })
    expect(h.registry.getBindings(h.workspaceId)).toHaveLength(2)

    h.registry.onSessionEvent(
      RPC_CHANNELS.sessions.EVENT,
      { to: 'workspace', workspaceId: h.workspaceId },
      { type: 'text_complete', sessionId: 'auto-s3', text: 'Auto-resolved summary' },
    )
    h.registry.onSessionEvent(
      RPC_CHANNELS.sessions.EVENT,
      { to: 'workspace', workspaceId: h.workspaceId },
      { type: 'complete', sessionId: 'auto-s3' },
    )

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sentTexts).toEqual([{ channelId: 'wx-latest', text: 'Auto-resolved summary' }])
  })
})

describe('MessagingGatewayRegistry.bindWorkspaceSupergroup — chat-type validation', () => {
  it('rejects when getChatInfo returns null (unable to read chat)', async () => {
    const h = makeRegistry()
    const { adapter } = makeFakeTelegramAdapter({ chatInfo: null })
    h.registry.getConfig(h.workspaceId)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = (h.registry as any).workspaces.get(h.workspaceId)
    state.gateway.registerAdapter(adapter)

    await expect(
      h.registry.bindWorkspaceSupergroup(h.workspaceId, 'telegram', '-100999'),
    ).rejects.toThrow(/unable to read chat metadata/i)
  })

  it('rejects when chat type is private (DM)', async () => {
    const h = makeRegistry()
    const { adapter } = makeFakeTelegramAdapter({
      chatInfo: { type: 'private' },
    })
    h.registry.getConfig(h.workspaceId)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = (h.registry as any).workspaces.get(h.workspaceId)
    state.gateway.registerAdapter(adapter)

    await expect(
      h.registry.bindWorkspaceSupergroup(h.workspaceId, 'telegram', '8658570288'),
    ).rejects.toThrow(/chat type is "private"/)
  })

  it('rejects supergroups with topics disabled', async () => {
    const h = makeRegistry()
    const { adapter } = makeFakeTelegramAdapter({
      chatInfo: { type: 'supergroup', isForum: false, title: 'Plain SG' },
    })
    h.registry.getConfig(h.workspaceId)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = (h.registry as any).workspaces.get(h.workspaceId)
    state.gateway.registerAdapter(adapter)

    await expect(
      h.registry.bindWorkspaceSupergroup(h.workspaceId, 'telegram', '-100999'),
    ).rejects.toThrow(/does not have topics enabled/i)
  })

  it('accepts forum supergroups and persists the title from getChatInfo', async () => {
    const h = makeRegistry()
    const { adapter } = makeFakeTelegramAdapter({
      chatInfo: { type: 'supergroup', isForum: true, title: 'My Forum' },
    })
    h.registry.getConfig(h.workspaceId)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = (h.registry as any).workspaces.get(h.workspaceId)
    state.gateway.registerAdapter(adapter)

    const result = await h.registry.bindWorkspaceSupergroup(
      h.workspaceId,
      'telegram',
      '-100999',
      'fallback-title',
    )
    expect(result.title).toBe('My Forum')

    const sg = h.registry.getWorkspaceSupergroup(h.workspaceId)
    expect(sg).toEqual({
      chatId: '-100999',
      title: 'My Forum',
      capturedAt: expect.any(Number),
    })
  })
})
