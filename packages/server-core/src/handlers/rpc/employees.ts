import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.employees.GET,
  RPC_CHANNELS.employees.GET_ONE,
  RPC_CHANNELS.employees.CREATE,
  RPC_CHANNELS.employees.UPDATE,
  RPC_CHANNELS.employees.DELETE,
  RPC_CHANNELS.employees.UPDATE_DEFINITION,
  RPC_CHANNELS.employees.UPDATE_MEMORY,
] as const

export function registerEmployeesHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger

  async function broadcastChanged(workspaceId: string, workspaceRootPath: string): Promise<void> {
    const { loadWorkspaceEmployees } = await import('@craft-agent/shared/employees')
    const employees = loadWorkspaceEmployees(workspaceRootPath)
    pushTyped(server, RPC_CHANNELS.employees.CHANGED, { to: 'workspace', workspaceId }, workspaceId, employees)
  }

  server.handle(RPC_CHANNELS.employees.GET, async (_ctx, workspaceId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      log.error(`EMPLOYEES_GET: Workspace not found: ${workspaceId}`)
      return []
    }
    const { loadWorkspaceEmployees } = await import('@craft-agent/shared/employees')
    return loadWorkspaceEmployees(workspace.rootPath)
  })

  server.handle(RPC_CHANNELS.employees.GET_ONE, async (_ctx, workspaceId: string, employeeIdOrSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return null
    const { loadEmployee, loadEmployeeById } = await import('@craft-agent/shared/employees')
    return loadEmployee(workspace.rootPath, employeeIdOrSlug)
      ?? loadEmployeeById(workspace.rootPath, employeeIdOrSlug)
  })

  server.handle(RPC_CHANNELS.employees.CREATE, async (_ctx, workspaceId: string, input: import('@craft-agent/shared/employees').CreateEmployeeInput) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { createEmployee } = await import('@craft-agent/shared/employees')
    const employee = createEmployee(workspace.rootPath, {
      name: input.name?.trim() || 'New Employee',
      description: input.description,
      color: input.color,
      skillSlugs: input.skillSlugs,
      enabledSourceSlugs: input.enabledSourceSlugs,
      definition: input.definition,
    })
    await broadcastChanged(workspaceId, workspace.rootPath)
    log.info(`Created employee: ${employee.slug}`)
    return employee
  })

  server.handle(RPC_CHANNELS.employees.UPDATE, async (
    _ctx,
    workspaceId: string,
    employeeSlug: string,
    patch: Partial<Omit<import('@craft-agent/shared/employees').EmployeeConfig, 'id' | 'slug' | 'createdAt'>>,
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { updateEmployee } = await import('@craft-agent/shared/employees')
    const updated = updateEmployee(workspace.rootPath, employeeSlug, patch)
    await broadcastChanged(workspaceId, workspace.rootPath)
    return updated
  })

  server.handle(RPC_CHANNELS.employees.UPDATE_DEFINITION, async (_ctx, workspaceId: string, employeeSlug: string, content: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { updateEmployeeDefinition } = await import('@craft-agent/shared/employees')
    updateEmployeeDefinition(workspace.rootPath, employeeSlug, content)
    await broadcastChanged(workspaceId, workspace.rootPath)
  })

  server.handle(RPC_CHANNELS.employees.UPDATE_MEMORY, async (_ctx, workspaceId: string, employeeSlug: string, content: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { updateEmployeeMemory } = await import('@craft-agent/shared/employees')
    updateEmployeeMemory(workspace.rootPath, employeeSlug, content)
    await broadcastChanged(workspaceId, workspace.rootPath)
  })

  server.handle(RPC_CHANNELS.employees.DELETE, async (_ctx, workspaceId: string, employeeSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)

    const { loadEmployee, deleteEmployee } = await import('@craft-agent/shared/employees')
    const employee = loadEmployee(workspace.rootPath, employeeSlug)
    if (!employee) {
      log.warn(`EMPLOYEES_DELETE: employee ${employeeSlug} not found`)
      return
    }

    const { unbindEmployeeFromSessions } = await import('@craft-agent/shared/sessions')
    const touched = await unbindEmployeeFromSessions(workspace.rootPath, employee.config.id)
    deleteEmployee(workspace.rootPath, employeeSlug)
    await broadcastChanged(workspaceId, workspace.rootPath)
    log.info(`Deleted employee ${employeeSlug} (unbound ${touched} sessions)`)
  })
}
