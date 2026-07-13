import { describe, expect, it } from 'bun:test'
import type { SessionScopedToolCallbacks } from '@craft-agent/shared/agent'
import type { Session } from '@craft-agent/shared/protocol'
import { SessionManager } from './SessionManager.ts'

type ListMessagingSessionsFn = NonNullable<SessionScopedToolCallbacks['listMessagingSessionsFn']>
type ListMessagingSessionsOptions = Parameters<ListMessagingSessionsFn>[0]
type ListMessagingSessionsResult = ReturnType<ListMessagingSessionsFn>

function installSessions(sm: SessionManager): void {
  const sessions: Session[] = [
    {
      id: 'recent-target',
      workspaceId: 'ws-a',
      workspaceName: 'A',
      name: 'Recent Telegram target',
      lastMessageAt: 200,
      messages: [],
      isProcessing: false,
      sessionStatus: 'todo',
      labels: ['ops'],
      createdAt: 20,
    },
    {
      id: 'older-target',
      workspaceId: 'ws-a',
      workspaceName: 'A',
      name: 'Weixin reports',
      lastMessageAt: 100,
      messages: [],
      isProcessing: false,
      sessionStatus: 'in-progress',
      createdAt: 10,
    },
  ]

  ;(sm as unknown as { getSessions: (workspaceId?: string) => Session[] }).getSessions =
    (workspaceId?: string) => sessions.filter((session) => !workspaceId || session.workspaceId === workspaceId)
}

function query(
  sm: SessionManager,
  options?: ListMessagingSessionsOptions,
): ListMessagingSessionsResult {
  return (sm as unknown as {
    listMessagingSessions: (
      workspaceId: string,
      options?: ListMessagingSessionsOptions,
    ) => ListMessagingSessionsResult
  }).listMessagingSessions('ws-a', options)
}

describe('SessionManager messaging session lookup', () => {
  it('is available before the provider is installed and observes a late provider', () => {
    const sm = new SessionManager()
    installSessions(sm)

    expect(query(sm, { platform: 'telegram' })).toEqual({
      total: 0,
      returned: 0,
      sessions: [],
    })

    sm.setMessagingBindingLookup((workspaceId) => [{
      id: 'tg-1',
      workspaceId,
      sessionId: 'recent-target',
      platform: 'telegram',
      channelId: 'chat-1',
      channelName: 'Ops alerts',
      enabled: true,
      createdAt: 300,
    }])

    expect(query(sm, { platform: 'telegram' }).sessions[0]).toMatchObject({
      id: 'recent-target',
      bindings: [{ bindingId: 'tg-1', platform: 'telegram', channelId: 'chat-1' }],
    })
  })

  it('filters by workspace platform and enabled state, drops stale sessions, and groups topics', () => {
    const sm = new SessionManager()
    installSessions(sm)
    sm.setMessagingBindingLookup(() => [
      {
        id: 'tg-topic-7', workspaceId: 'ws-a', sessionId: 'recent-target', platform: 'telegram',
        channelId: '-1001', channelName: 'Ops', threadId: 7, enabled: true, createdAt: 307,
      },
      {
        id: 'tg-topic-5', workspaceId: 'ws-a', sessionId: 'recent-target', platform: 'telegram',
        channelId: '-1001', channelName: 'Ops', threadId: 5, enabled: true, createdAt: 305,
      },
      {
        id: 'wx-same-session', workspaceId: 'ws-a', sessionId: 'recent-target', platform: 'weixin',
        channelId: 'wx-1', enabled: true, createdAt: 304,
      },
      {
        id: 'wx-disabled', workspaceId: 'ws-a', sessionId: 'older-target', platform: 'weixin',
        channelId: 'wx-disabled', enabled: false, createdAt: 303,
      },
      {
        id: 'tg-stale', workspaceId: 'ws-a', sessionId: 'deleted-session', platform: 'telegram',
        channelId: 'stale', enabled: true, createdAt: 302,
      },
      {
        id: 'tg-other-workspace', workspaceId: 'ws-b', sessionId: 'recent-target', platform: 'telegram',
        channelId: 'leak', enabled: true, createdAt: 301,
      },
    ])

    const result = query(sm, { platform: 'telegram' })

    expect(result.total).toBe(1)
    expect(result.sessions[0]?.id).toBe('recent-target')
    expect(result.sessions[0]?.bindings.map((binding) => binding.bindingId)).toEqual([
      'tg-topic-7',
      'tg-topic-5',
    ])
    expect(result.sessions[0]?.bindings.map((binding) => binding.threadId)).toEqual([7, 5])
  })

  it('searches channel metadata and paginates after grouping in recent-session order', () => {
    const sm = new SessionManager()
    installSessions(sm)
    sm.setMessagingBindingLookup(() => [
      {
        id: 'tg-recent', workspaceId: 'ws-a', sessionId: 'recent-target', platform: 'telegram',
        channelId: 'chat-recent', channelName: 'Daily Alerts', enabled: true, createdAt: 1,
      },
      {
        id: 'wx-older', workspaceId: 'ws-a', sessionId: 'older-target', platform: 'weixin',
        channelId: 'wx-daily', channelName: 'Daily Reports', enabled: true, createdAt: 2,
      },
    ])

    const searched = query(sm, { search: 'daily' })
    expect(searched.sessions.map((session) => session.id)).toEqual(['recent-target', 'older-target'])

    const page = query(sm, { search: 'daily', limit: 1, offset: 1 })
    expect(page).toMatchObject({ total: 2, returned: 1 })
    expect(page.sessions[0]?.id).toBe('older-target')
  })
})
