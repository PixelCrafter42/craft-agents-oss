import { describe, expect, it } from 'bun:test'
import {
  buildRouteFromNavigationState,
  parseCompoundRoute,
  parseRouteToNavigationState,
} from '../route-parser'

describe('route-parser: employee sessions view', () => {
  it('parses the employee view without a selected session', () => {
    expect(parseCompoundRoute('employeeSessions')).toEqual({
      navigator: 'sessions',
      sessionFilter: { kind: 'allSessions' },
      viewMode: 'employee',
      details: null,
    })
  })

  it('round-trips a selected session without losing employee view mode', () => {
    const state = parseRouteToNavigationState('employeeSessions/session/session-1')

    expect(state).toEqual({
      navigator: 'sessions',
      filter: { kind: 'allSessions' },
      viewMode: 'employee',
      details: { type: 'session', sessionId: 'session-1' },
    })
    expect(buildRouteFromNavigationState(state!)).toBe('employeeSessions/session/session-1')
  })
})
