import { describe, expect, it } from 'bun:test'
import {
  buildRouteFromNavigationState,
  parseCompoundRoute,
  parseRouteToNavigationState,
} from '../route-parser'
import { routes } from '../routes'

describe('route-parser: employee sessions view', () => {
  it('parses the employee view without a selected session', () => {
    expect(parseCompoundRoute('employeeSessions')).toEqual({
      navigator: 'sessions',
      sessionFilter: { kind: 'allSessions' },
      viewMode: 'employee',
      details: null,
    })
  })

  it('round-trips as a full-width view without session details', () => {
    const state = parseRouteToNavigationState('employeeSessions')

    expect(state).toEqual({
      navigator: 'sessions',
      filter: { kind: 'allSessions' },
      viewMode: 'employee',
      details: null,
    })
    expect(buildRouteFromNavigationState(state!)).toBe('employeeSessions')
  })
})

describe('route-parser: unread sessions view', () => {
  it('parses the unread view without a selected session', () => {
    expect(parseCompoundRoute('unread')).toEqual({
      navigator: 'sessions',
      sessionFilter: { kind: 'unread' },
      details: null,
    })
  })

  it('round-trips unread routes with session details', () => {
    const route = routes.view.unread('session-1')
    expect(route).toBe('unread/session/session-1')

    const state = parseRouteToNavigationState(route)
    expect(state).toEqual({
      navigator: 'sessions',
      filter: { kind: 'unread' },
      details: { type: 'session', sessionId: 'session-1' },
    })
    expect(buildRouteFromNavigationState(state!)).toBe(route)
  })
})
