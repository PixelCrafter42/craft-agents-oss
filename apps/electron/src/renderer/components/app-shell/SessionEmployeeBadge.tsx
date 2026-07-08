import { UserRound } from 'lucide-react'
import { EntityListBadge } from '@/components/ui/entity-list-badge'

export interface SessionEmployeeBadgeEmployee {
  id: string
  name: string
  color?: string
}

interface SessionEmployeeBadgeProps {
  employee?: SessionEmployeeBadgeEmployee
  employeeId?: string
  size?: 'list' | 'header'
}

export function SessionEmployeeBadge({ employee, employeeId, size = 'list' }: SessionEmployeeBadgeProps) {
  const name = employee?.name ?? 'Unknown employee'
  const color = employee?.color
  const tooltip = employee
    ? `Employee: ${employee.name}`
    : `Missing employee: ${employeeId ?? 'unknown'}`

  return (
    <EntityListBadge
      colorClass={color ? undefined : 'bg-teal-500/10 text-teal-700 dark:bg-teal-400/15 dark:text-teal-300'}
      style={color
        ? {
            color,
            backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
          }
        : undefined}
      tooltip={tooltip}
      className={size === 'header'
        ? 'gap-1 max-w-[180px] h-5 px-1.5'
        : 'gap-1 max-w-[160px]'}
    >
      <UserRound className="h-3 w-3 shrink-0" />
      <span className="truncate">{name}</span>
    </EntityListBadge>
  )
}
