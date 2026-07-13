import { describe, expect, it } from 'bun:test'
import type { SessionMeta } from '@/atoms/sessions'
import {
  getVisibleEmployeeIds,
  resolveEmployeeColumnId,
  UNASSIGNED_EMPLOYEE_COLUMN_ID,
} from '../model'

const employees = [
  { id: 'alice', name: 'Alice' },
  { id: 'bob', name: 'Bob' },
]

function session(id: string, employeeId?: string): SessionMeta {
  return { id, workspaceId: 'workspace-1', employeeId }
}

describe('employee board model', () => {
  it('keeps configured employee order while hiding empty employees', () => {
    expect(getVisibleEmployeeIds(employees, [session('s1', 'bob')], false)).toEqual(['bob'])
    expect(getVisibleEmployeeIds(employees, [session('s1', 'bob')], true)).toEqual(['alice', 'bob'])
  })

  it('puts missing and stale employee assignments in the unassigned column', () => {
    const knownIds = new Set(employees.map(employee => employee.id))
    expect(resolveEmployeeColumnId(undefined, knownIds)).toBe(UNASSIGNED_EMPLOYEE_COLUMN_ID)
    expect(resolveEmployeeColumnId('deleted', knownIds)).toBe(UNASSIGNED_EMPLOYEE_COLUMN_ID)
    expect(resolveEmployeeColumnId('alice', knownIds)).toBe('alice')
  })
})
