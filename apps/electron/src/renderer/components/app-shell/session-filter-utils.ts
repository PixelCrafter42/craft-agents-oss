export type SessionFilterMode = 'include' | 'exclude'

export interface InheritedNewSessionParams {
  status?: string
  label?: string
  project?: string
  employee?: string
}

interface InheritedFilterMaps {
  statuses: ReadonlyMap<string, SessionFilterMode>
  labels: ReadonlyMap<string, SessionFilterMode>
  projects: ReadonlyMap<string, SessionFilterMode>
  employees: ReadonlyMap<string, SessionFilterMode>
}

/**
 * Inherit only one unambiguous include filter. Excludes describe what the new
 * session must not be, so turning one into an assignment reverses its meaning.
 */
export function getInheritedNewSessionParams({
  statuses,
  labels,
  projects,
  employees,
}: InheritedFilterMaps): InheritedNewSessionParams | null {
  const total = statuses.size + labels.size + projects.size + employees.size
  if (total !== 1) return null

  const soleInclude = (filter: ReadonlyMap<string, SessionFilterMode>): string | null => {
    const entry = filter.entries().next().value
    return entry?.[1] === 'include' ? entry[0] : null
  }

  if (statuses.size === 1) {
    const status = soleInclude(statuses)
    return status ? { status } : null
  }
  if (labels.size === 1) {
    const label = soleInclude(labels)
    return label ? { label } : null
  }
  if (projects.size === 1) {
    const project = soleInclude(projects)
    return project ? { project } : null
  }

  const employee = soleInclude(employees)
  return employee ? { employee } : null
}
