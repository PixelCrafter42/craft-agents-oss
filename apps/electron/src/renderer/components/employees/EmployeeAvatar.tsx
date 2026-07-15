import * as React from 'react'
import { UserRound } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface EmployeeAvatarEmployee {
  name?: string
  color?: string
  avatarDataUrl?: string
}

interface EmployeeAvatarProps {
  employee?: EmployeeAvatarEmployee | { config: EmployeeAvatarEmployee; avatarDataUrl?: string }
  size?: 'xs' | 'sm' | 'md' | 'lg'
  className?: string
  fallbackClassName?: string
}

const SIZE_CLASSES = {
  xs: 'h-3.5 w-3.5 rounded-[3px]',
  sm: 'h-5 w-5 rounded-[5px]',
  md: 'h-8 w-8 rounded-[7px]',
  lg: 'h-14 w-14 rounded-[12px]',
} as const

const ICON_CLASSES = {
  xs: 'h-2.5 w-2.5',
  sm: 'h-3.5 w-3.5',
  md: 'h-5 w-5',
  lg: 'h-8 w-8',
} as const

export function EmployeeAvatar({
  employee,
  size = 'sm',
  className,
  fallbackClassName,
}: EmployeeAvatarProps) {
  const sharedClassName = cn('shrink-0 overflow-hidden', SIZE_CLASSES[size], className)
  const appearance = employee && 'config' in employee
    ? { ...employee.config, avatarDataUrl: employee.avatarDataUrl }
    : employee

  if (appearance?.avatarDataUrl) {
    return (
      <img
        src={appearance.avatarDataUrl}
        alt=""
        draggable={false}
        className={cn(sharedClassName, 'object-cover')}
      />
    )
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        sharedClassName,
        'inline-flex items-center justify-center bg-foreground/[0.06] text-foreground/55',
        fallbackClassName,
      )}
      style={appearance?.color && !fallbackClassName
        ? {
            color: appearance.color,
            backgroundColor: `color-mix(in srgb, ${appearance.color} 12%, transparent)`,
          }
        : undefined}
    >
      <UserRound className={ICON_CLASSES[size]} />
    </span>
  )
}
