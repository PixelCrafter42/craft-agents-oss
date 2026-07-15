import type { SessionMeta } from '@/atoms/sessions'

export const UNASSIGNED_EMPLOYEE_COLUMN_ID = '__unassigned__'

export interface EmployeeBoardEmployee {
  id: string
  name: string
  color?: string
  avatarDataUrl?: string
}

export function resolveEmployeeColumnId(
  employeeId: string | undefined,
  knownEmployeeIds: ReadonlySet<string>,
): string {
  return employeeId && knownEmployeeIds.has(employeeId)
    ? employeeId
    : UNASSIGNED_EMPLOYEE_COLUMN_ID
}

export function getVisibleEmployeeIds(
  employees: readonly EmployeeBoardEmployee[],
  sessions: readonly SessionMeta[],
  showEmptyEmployees: boolean,
): string[] {
  if (showEmptyEmployees) return employees.map(employee => employee.id)
  const assignedIds = new Set(sessions.flatMap(session => session.employeeId ? [session.employeeId] : []))
  return employees.filter(employee => assignedIds.has(employee.id)).map(employee => employee.id)
}
