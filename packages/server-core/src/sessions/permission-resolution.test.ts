import { describe, expect, it, mock } from 'bun:test'
import { SessionManager } from './SessionManager'

describe('SessionManager permission resolution lifecycle', () => {
  it('accepts only the matching pending request and emits its exact requestId', () => {
    const manager = new SessionManager()
    const respondToPermission = mock(() => {})
    const events: Array<Record<string, unknown>> = []

    ;(manager as any).sessions.set('sess-A', {
      id: 'sess-A',
      workspace: { id: 'ws-A' },
      agent: { respondToPermission },
    })
    ;(manager as any).pendingPermissionRequests.set('req-live', {
      sessionId: 'sess-A',
      type: 'bash',
    })
    manager.setEventSink(((...args: unknown[]) => {
      events.push(args[2] as Record<string, unknown>)
    }) as any)

    expect(manager.respondToPermission('sess-A', 'req-stale', true, false)).toBe(false)
    expect(manager.respondToPermission('other-session', 'req-live', true, false)).toBe(false)
    expect(respondToPermission).not.toHaveBeenCalled()

    expect(manager.respondToPermission('sess-A', 'req-live', true, false)).toBe(true)
    expect(respondToPermission).toHaveBeenCalledWith('req-live', true, false)
    expect(events).toContainEqual({
      type: 'permission_resolved',
      sessionId: 'sess-A',
      requestId: 'req-live',
    })

    expect(manager.respondToPermission('sess-A', 'req-live', true, false)).toBe(false)
    expect(respondToPermission).toHaveBeenCalledTimes(1)
  })
})
