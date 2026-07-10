import { describe, expect, it } from 'bun:test'
import { getInheritedNewSessionParams, type SessionFilterMode } from '../session-filter-utils'

const empty = (): Map<string, SessionFilterMode> => new Map()

describe('getInheritedNewSessionParams', () => {
  it('inherits a sole include from each supported filter family', () => {
    expect(getInheritedNewSessionParams({
      statuses: new Map([['in-progress', 'include']]),
      labels: empty(),
      projects: empty(),
      employees: empty(),
    })).toEqual({ status: 'in-progress' })

    expect(getInheritedNewSessionParams({
      statuses: empty(),
      labels: empty(),
      projects: new Map([['project-1', 'include']]),
      employees: empty(),
    })).toEqual({ project: 'project-1' })

    expect(getInheritedNewSessionParams({
      statuses: empty(),
      labels: empty(),
      projects: empty(),
      employees: new Map([['employee-1', 'include']]),
    })).toEqual({ employee: 'employee-1' })
  })

  it('never reverses a sole exclude into a new-session assignment', () => {
    expect(getInheritedNewSessionParams({
      statuses: empty(),
      labels: new Map([['blocked', 'exclude']]),
      projects: empty(),
      employees: empty(),
    })).toBeNull()
  })

  it('does not inherit when more than one filter is active', () => {
    expect(getInheritedNewSessionParams({
      statuses: new Map([['todo', 'include']]),
      labels: empty(),
      projects: new Map([['project-1', 'exclude']]),
      employees: empty(),
    })).toBeNull()
  })
})
