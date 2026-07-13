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
