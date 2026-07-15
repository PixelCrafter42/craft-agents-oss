/**
 * EmployeesListPanel
 *
 * Workspace-scoped employee list shown in the navigator slot when the Employees
 * sidebar item is active.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { MessageSquare, Plus, Trash2, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { EntityRow } from '@/components/ui/entity-row'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { useMenuComponents, ContextMenuProvider } from '@/components/ui/menu-context'
import {
  ContextMenu,
  ContextMenuTrigger,
  StyledContextMenuContent,
} from '@/components/ui/styled-context-menu'
import type { LoadedEmployee } from '@craft-agent/shared/employees/types'
import { EmployeeAvatar } from '@/components/employees/EmployeeAvatar'

export interface EmployeesListPanelProps {
  employees: LoadedEmployee[]
  workspaceId: string
  onEmployeeClick: (slug: string) => void
  onAddEmployee?: () => void
  onJumpToSessions?: (employeeId: string) => void
  selectedEmployeeSlug?: string | null
  className?: string
}

export function EmployeesListPanel({
  employees,
  workspaceId,
  onEmployeeClick,
  onAddEmployee,
  onJumpToSessions,
  selectedEmployeeSlug,
  className,
}: EmployeesListPanelProps) {
  const { t } = useTranslation()

  const handleDelete = React.useCallback(async (employee: LoadedEmployee) => {
    if (!window.confirm(t('employeeInfo.deleteConfirm', `删除员工「${employee.config.name}」？相关会话会被解绑。`, { name: employee.config.name }))) return
    try {
      await window.electronAPI.deleteEmployee(workspaceId, employee.config.slug)
      toast.success(t('employeeInfo.deleted', '员工已删除'))
    } catch (err) {
      console.error('[EmployeesListPanel] Failed to delete employee:', err)
      toast.error(t('employeeInfo.deleteFailed', '删除失败'))
    }
  }, [workspaceId, t])

  if (employees.length === 0) {
    return (
      <div className={cn('flex flex-col flex-1 min-h-0', className)}>
        <EntityListEmptyScreen
          icon={<UserRound />}
          title={t('employeesList.empty', '还没有员工')}
          description={t('employeesList.emptyDescription', '创建员工后，可以给会话绑定固定身份、默认技能和默认数据源。')}
        >
          {onAddEmployee && (
            <button
              type="button"
              onClick={onAddEmployee}
              className="inline-flex items-center gap-1 h-7 px-3 text-xs font-medium rounded-[8px] bg-background shadow-minimal hover:bg-foreground/[0.03] transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('employeesList.addEmployee', '添加员工')}
            </button>
          )}
        </EntityListEmptyScreen>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col flex-1 min-h-0', className)}>
      <ScrollArea className="flex-1">
        <div className="pb-2" data-list-role="employees">
          <div className="pt-1">
            {employees.map((employee, index) => (
              <EmployeeRow
                key={employee.config.slug}
                employee={employee}
                isSelected={selectedEmployeeSlug === employee.config.slug}
                isFirst={index === 0}
                onClick={() => onEmployeeClick(employee.config.slug)}
                onDelete={() => handleDelete(employee)}
                onJumpToSessions={onJumpToSessions ? () => onJumpToSessions(employee.config.id) : undefined}
              />
            ))}
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}

interface EmployeeRowProps {
  employee: LoadedEmployee
  isSelected: boolean
  isFirst: boolean
  onClick: () => void
  onDelete: () => void
  onJumpToSessions?: () => void
}

function EmployeeRow({ employee, isSelected, isFirst, onClick, onDelete, onJumpToSessions }: EmployeeRowProps) {
  const config = employee.config
  const subtitle = config.description?.trim() || config.slug

  return (
    <ContextMenu modal={true}>
      <ContextMenuTrigger asChild>
        <div>
          <EntityRow
            showSeparator={!isFirst}
            separatorClassName="pl-10 pr-4"
            isSelected={isSelected}
            onMouseDown={(e: React.MouseEvent) => {
              if (e.button === 0) onClick()
            }}
            icon={<EmployeeAvatar employee={employee} size="xs" />}
            title={config.name}
            subtitle={subtitle}
          />
        </div>
      </ContextMenuTrigger>
      <StyledContextMenuContent>
        <ContextMenuProvider>
          <EmployeeRowMenu onDelete={onDelete} onJumpToSessions={onJumpToSessions} />
        </ContextMenuProvider>
      </StyledContextMenuContent>
    </ContextMenu>
  )
}

function EmployeeRowMenu({ onDelete, onJumpToSessions }: { onDelete: () => void; onJumpToSessions?: () => void }) {
  const { t } = useTranslation()
  const { MenuItem, Separator } = useMenuComponents()
  return (
    <>
      {onJumpToSessions && (
        <>
          <MenuItem onClick={onJumpToSessions}>
            <MessageSquare className="h-3.5 w-3.5" />
            <span className="flex-1">{t('employeesList.jumpToSessions', '查看相关会话')}</span>
          </MenuItem>
          <Separator />
        </>
      )}
      <MenuItem onClick={onDelete} variant="destructive">
        <Trash2 className="h-3.5 w-3.5" />
        <span className="flex-1">{t('employeesList.delete', '删除')}</span>
      </MenuItem>
    </>
  )
}
