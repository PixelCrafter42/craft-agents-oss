import * as React from 'react'
import { Eye, EyeOff, Inbox, UserRoundX } from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  closestCorners,
  DndContext,
  DragOverlay,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { sessionMetaMapAtom, updateSessionMetaAtom, type SessionMeta } from '@/atoms/sessions'
import { projectsAtom } from '@/atoms/projects'
import { useAppShellContext } from '@/context/AppShellContext'
import { useNavigation } from '@/contexts/NavigationContext'
import { SmartPointerSensor } from '@/components/ui/sortable-list'
import { getSessionTitle } from '@/utils/session'
import { useProjectColorTreatment } from '@/hooks/useProjectColorTreatment'
import type { SessionStatus } from '@/config/session-status-config'
import type { ProjectColorTreatment } from '@/utils/project-colors'
import { EmployeeAvatar } from '@/components/employees/EmployeeAvatar'
import { DEFAULT_MODEL } from '@config/models'
import { routes } from '@/lib/navigate'
import { BoardListToggle } from '../kanban/BoardListToggle'
import { TaskTile } from '../kanban/TaskTile'
import type { KanbanProject, KanbanTask } from '../kanban/types'
import {
  getVisibleEmployeeIds,
  resolveEmployeeColumnId,
  UNASSIGNED_EMPLOYEE_COLUMN_ID,
  type EmployeeBoardEmployee,
} from './model'

const FALLBACK_EMPLOYEE_COLORS = ['#0d9488', '#6366f1', '#d97706', '#db2777', '#7c3aed', '#059669']

interface EmployeeColumnModel extends EmployeeBoardEmployee {
  sessions: KanbanTask[]
  activeCount: number
}

export function EmployeeBoardContainer() {
  const { t } = useTranslation()
  const {
    activeWorkspaceId,
    workspaces,
    employees = [],
    sessionStatuses = [],
  } = useAppShellContext()
  const metaMap = useAtomValue(sessionMetaMapAtom)
  const projects = useAtomValue(projectsAtom)
  const updateSessionMeta = useSetAtom(updateSessionMetaAtom)
  const treatment = useProjectColorTreatment()
  const { navigate } = useNavigation()
  const [showEmptyEmployees, setShowEmptyEmployees] = React.useState(false)
  const [activeSessionId, setActiveSessionId] = React.useState<string | null>(null)

  const remoteWorkspaceId = workspaces.find(workspace => workspace.id === activeWorkspaceId)
    ?.remoteServer?.remoteWorkspaceId

  const workspaceSessions = React.useMemo(() => {
    return Array.from(metaMap.values()).filter(session => {
      const matchesWorkspace = !activeWorkspaceId
        || session.workspaceId === activeWorkspaceId
        || session.workspaceId === remoteWorkspaceId
      return matchesWorkspace && !session.hidden && !session.isArchived && !session.taskDraft
    })
  }, [activeWorkspaceId, metaMap, remoteWorkspaceId])

  const statusesById = React.useMemo(
    () => new Map(sessionStatuses.map(status => [status.id, status])),
    [sessionStatuses],
  )

  const projectsById = React.useMemo(() => {
    const result = new Map<string, KanbanProject>()
    for (const project of projects) {
      if (!project.config.color) continue
      result.set(project.config.id, {
        id: project.config.id,
        name: project.config.name,
        color: project.config.color,
      })
    }
    return result
  }, [projects])

  const knownEmployeeIds = React.useMemo(
    () => new Set(employees.map(employee => employee.id)),
    [employees],
  )

  const tasks = React.useMemo<KanbanTask[]>(() => {
    return workspaceSessions.map(session => ({
      id: session.id,
      title: getSessionTitle(session),
      column: resolveEmployeeColumnId(session.employeeId, knownEmployeeIds),
      statusId: session.sessionStatus ?? 'todo',
      model: session.model ?? DEFAULT_MODEL,
      projectId: session.projectId,
      subtasks: [],
      isFlagged: session.isFlagged,
      isProcessing: session.isProcessing,
      createdAt: session.createdAt,
      lastMessageAt: session.lastMessageAt,
      messageCount: session.messageCount,
      costUsd: session.tokenUsage?.costUsd,
    }))
  }, [knownEmployeeIds, workspaceSessions])

  const columns = React.useMemo<EmployeeColumnModel[]>(() => {
    const tasksByColumn = new Map<string, KanbanTask[]>()
    for (const task of tasks) {
      const bucket = tasksByColumn.get(task.column)
      if (bucket) bucket.push(task)
      else tasksByColumn.set(task.column, [task])
    }
    for (const bucket of tasksByColumn.values()) {
      bucket.sort((a, b) => (b.lastMessageAt ?? b.createdAt ?? 0) - (a.lastMessageAt ?? a.createdAt ?? 0))
    }

    const employeeById = new Map(employees.map(employee => [employee.id, employee]))
    const visibleEmployeeIds = getVisibleEmployeeIds(employees, workspaceSessions, showEmptyEmployees)
    const result = visibleEmployeeIds.flatMap((employeeId, index): EmployeeColumnModel[] => {
      const employee = employeeById.get(employeeId)
      if (!employee) return []
      const employeeTasks = tasksByColumn.get(employeeId) ?? []
      return [{
        ...employee,
        color: employee.color ?? FALLBACK_EMPLOYEE_COLORS[index % FALLBACK_EMPLOYEE_COLORS.length],
        sessions: employeeTasks,
        activeCount: employeeTasks.filter(task => task.isProcessing).length,
      }]
    })

    const unassignedTasks = tasksByColumn.get(UNASSIGNED_EMPLOYEE_COLUMN_ID) ?? []
    if (tasks.length > 0 || showEmptyEmployees) {
      result.push({
        id: UNASSIGNED_EMPLOYEE_COLUMN_ID,
        name: t('sidebar.noEmployee'),
        color: '#64748b',
        sessions: unassignedTasks,
        activeCount: unassignedTasks.filter(task => task.isProcessing).length,
      })
    }
    return result
  }, [employees, showEmptyEmployees, t, tasks, workspaceSessions])

  const activeTask = activeSessionId ? tasks.find(task => task.id === activeSessionId) : undefined
  const activeColumn = activeTask ? columns.find(column => column.id === activeTask.column) : undefined
  const sensors = useSensors(useSensor(SmartPointerSensor, { activationConstraint: { distance: 5 } }))

  const handleDragStart = React.useCallback((event: DragStartEvent) => {
    setActiveSessionId(String(event.active.id))
  }, [])

  const handleDragEnd = React.useCallback((event: DragEndEvent) => {
    setActiveSessionId(null)
    const sessionId = String(event.active.id)
    const destination = event.over ? String(event.over.id) : null
    const session = metaMap.get(sessionId)
    if (!session || !destination) return
    const nextEmployeeId = destination === UNASSIGNED_EMPLOYEE_COLUMN_ID ? null : destination
    const currentEmployeeId = session.employeeId ?? null
    if (currentEmployeeId === nextEmployeeId) return

    updateSessionMeta(sessionId, { employeeId: nextEmployeeId ?? undefined })
    void window.electronAPI.sessionCommand(sessionId, { type: 'setEmployeeId', employeeId: nextEmployeeId }).catch(error => {
      updateSessionMeta(sessionId, { employeeId: currentEmployeeId ?? undefined })
      console.error('[EmployeeBoard] Failed to move session:', error)
      toast.error(t('employeeBoard.moveFailed'))
    })
  }, [metaMap, t, updateSessionMeta])

  const handleStatusChange = React.useCallback((sessionId: string, statusId: string) => {
    const previousStatusId = metaMap.get(sessionId)?.sessionStatus
    updateSessionMeta(sessionId, { sessionStatus: statusId })
    void window.electronAPI.sessionCommand(sessionId, { type: 'setSessionStatus', state: statusId }).catch(error => {
      updateSessionMeta(sessionId, { sessionStatus: previousStatusId })
      console.error('[EmployeeBoard] Failed to change session status:', error)
    })
  }, [metaMap, updateSessionMeta])

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-between gap-3 border-b border-border/50 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-sm font-medium">{t('employeeBoard.title')}</span>
          <span className="rounded-full bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-foreground/55">
            {tasks.length}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowEmptyEmployees(value => !value)}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-xs font-medium text-foreground/65 transition-colors hover:bg-foreground/[0.03] hover:text-foreground"
          >
            {showEmptyEmployees ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            {t(showEmptyEmployees ? 'employeeBoard.hideEmpty' : 'employeeBoard.showEmpty')}
          </button>
          <BoardListToggle
            value="employee"
            onChange={view => {
              if (view === 'list') navigate(routes.view.allSessions())
              if (view === 'board') navigate(routes.view.board())
            }}
          />
        </div>
      </div>

      {columns.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
          <Inbox className="h-8 w-8 opacity-50" />
          <p className="text-sm font-medium">{t('session.noSessionsYet')}</p>
          <p className="text-xs">{t('session.noSessionsYetDesc')}</p>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveSessionId(null)}
        >
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
            <div
              className="grid items-start gap-3 p-3"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))' }}
            >
              {columns.map(column => (
                <EmployeeColumn
                  key={column.id}
                  column={column}
                  projectsById={projectsById}
                  statusesById={statusesById}
                  statuses={sessionStatuses}
                  treatment={treatment}
                  onOpenSession={sessionId => navigate(routes.view.allSessions(sessionId))}
                  onStatusChange={handleStatusChange}
                />
              ))}
            </div>
          </div>
          <DragOverlay dropAnimation={null} style={{ zIndex: 'var(--z-floating-menu, 400)' }}>
            {activeTask ? (
              <div className="w-[286px] cursor-grabbing rounded-lg shadow-strong" style={{ transform: 'scale(1.025)' }}>
                <TaskTile
                  task={activeTask}
                  project={activeTask.projectId ? projectsById.get(activeTask.projectId) : undefined}
                  status={statusesById.get(activeTask.statusId)}
                  treatment={treatment}
                  expanded={false}
                  accentColor={activeColumn?.color}
                  live={!!activeTask.isProcessing}
                />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  )
}

function EmployeeColumn({
  column,
  projectsById,
  statusesById,
  statuses,
  treatment,
  onOpenSession,
  onStatusChange,
}: {
  column: EmployeeColumnModel
  projectsById: Map<string, KanbanProject>
  statusesById: Map<string, SessionStatus>
  statuses: SessionStatus[]
  treatment: ProjectColorTreatment
  onOpenSession: (sessionId: string) => void
  onStatusChange: (sessionId: string, statusId: string) => void
}) {
  const { t } = useTranslation()
  const { setNodeRef, isOver } = useDroppable({ id: column.id })
  const isUnassigned = column.id === UNASSIGNED_EMPLOYEE_COLUMN_ID

  return (
    <section
      className="flex min-w-0 flex-col"
      style={{ height: 'clamp(360px, calc(100vh - 132px), 520px)' }}
    >
      <div className="flex items-center gap-2 px-0.5 pb-2">
        <span
          className="inline-flex min-w-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold text-white"
          style={{ backgroundColor: column.color }}
        >
          {isUnassigned
            ? <UserRoundX className="h-3.5 w-3.5 shrink-0" />
            : <EmployeeAvatar employee={column} size="sm" className="ring-1 ring-white/30" fallbackClassName="bg-white/15 text-white" />}
          <span className="truncate">{column.name}</span>
          <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-white/25 px-1 text-[10px] tabular-nums">
            {column.sessions.length}
          </span>
        </span>
        {column.activeCount > 0 && (
          <span
            title={t('employeeBoard.activeSessions', { count: column.activeCount })}
            className="inline-flex items-center gap-1 text-[10px] font-medium text-foreground/50"
          >
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
            {column.activeCount}
          </span>
        )}
      </div>
      <div
        ref={setNodeRef}
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-lg p-2 transition-shadow"
        style={{
          backgroundColor: `color-mix(in srgb, ${column.color} 6%, transparent)`,
          outline: isOver ? `2px solid ${column.color}` : undefined,
          outlineOffset: isOver ? '-2px' : undefined,
        }}
      >
        {column.sessions.map(task => (
          <EmployeeDraggableTile key={task.id} sessionId={task.id}>
            <TaskTile
              task={task}
              project={task.projectId ? projectsById.get(task.projectId) : undefined}
              status={statusesById.get(task.statusId)}
              statuses={statuses}
              onStatusChange={statusId => onStatusChange(task.id, statusId)}
              treatment={treatment}
              expanded={false}
              accentColor={column.color}
              live={!!task.isProcessing}
              onClick={() => onOpenSession(task.id)}
            />
          </EmployeeDraggableTile>
        ))}
      </div>
    </section>
  )
}

function EmployeeDraggableTile({ sessionId, children }: { sessionId: string; children: React.ReactNode }) {
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: sessionId })
  return (
    <div ref={setNodeRef} style={{ opacity: isDragging ? 0 : 1 }} {...listeners}>
      {children}
    </div>
  )
}
