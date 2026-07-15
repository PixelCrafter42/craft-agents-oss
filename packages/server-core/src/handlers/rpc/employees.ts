import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { assertValidEmployeeSlug, isValidEmployeeSlug } from '@craft-agent/shared/employees'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { ImageProcessor } from '../../runtime/platform'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.employees.GET,
  RPC_CHANNELS.employees.GET_ONE,
  RPC_CHANNELS.employees.CREATE,
  RPC_CHANNELS.employees.UPDATE,
  RPC_CHANNELS.employees.DELETE,
  RPC_CHANNELS.employees.UPDATE_AVATAR,
  RPC_CHANNELS.employees.DELETE_AVATAR,
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
    return (isValidEmployeeSlug(employeeIdOrSlug) ? loadEmployee(workspace.rootPath, employeeIdOrSlug) : null)
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
    assertValidEmployeeSlug(employeeSlug)
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { updateEmployee } = await import('@craft-agent/shared/employees')
    const updated = updateEmployee(workspace.rootPath, employeeSlug, patch)
    await broadcastChanged(workspaceId, workspace.rootPath)
    return updated
  })

  server.handle(RPC_CHANNELS.employees.UPDATE_DEFINITION, async (_ctx, workspaceId: string, employeeSlug: string, content: string) => {
    assertValidEmployeeSlug(employeeSlug)
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { updateEmployeeDefinition } = await import('@craft-agent/shared/employees')
    updateEmployeeDefinition(workspace.rootPath, employeeSlug, content)
    await broadcastChanged(workspaceId, workspace.rootPath)
  })

  server.handle(RPC_CHANNELS.employees.UPDATE_MEMORY, async (_ctx, workspaceId: string, employeeSlug: string, content: string) => {
    assertValidEmployeeSlug(employeeSlug)
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { updateEmployeeMemory } = await import('@craft-agent/shared/employees')
    updateEmployeeMemory(workspace.rootPath, employeeSlug, content)
    await broadcastChanged(workspaceId, workspace.rootPath)
  })

  server.handle(RPC_CHANNELS.employees.UPDATE_AVATAR, async (_ctx, workspaceId: string, employeeSlug: string, base64: string) => {
    assertValidEmployeeSlug(employeeSlug)
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    if (typeof base64 !== 'string' || base64.length === 0 || base64.length > 7_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      throw new Error('Invalid employee avatar data')
    }

    const input = Buffer.from(base64, 'base64')
    if (input.byteLength === 0 || input.byteLength > 5 * 1024 * 1024) {
      throw new Error('Employee avatar must be 5 MB or smaller')
    }

    let normalized: Buffer
    try {
      normalized = await normalizeEmployeeAvatar(input, deps.platform.imageProcessor)
    } catch {
      throw new Error('Employee avatar must be a valid PNG, JPEG, or WebP image')
    }

    const { updateEmployeeAvatar } = await import('@craft-agent/shared/employees')
    updateEmployeeAvatar(workspace.rootPath, employeeSlug, normalized)
    await broadcastChanged(workspaceId, workspace.rootPath)
  })

  server.handle(RPC_CHANNELS.employees.DELETE_AVATAR, async (_ctx, workspaceId: string, employeeSlug: string) => {
    assertValidEmployeeSlug(employeeSlug)
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { deleteEmployeeAvatar } = await import('@craft-agent/shared/employees')
    deleteEmployeeAvatar(workspace.rootPath, employeeSlug)
    await broadcastChanged(workspaceId, workspace.rootPath)
  })

  server.handle(RPC_CHANNELS.employees.DELETE, async (_ctx, workspaceId: string, employeeSlug: string) => {
    assertValidEmployeeSlug(employeeSlug)
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

export async function normalizeEmployeeAvatar(input: Buffer, imageProcessor: ImageProcessor): Promise<Buffer> {
  if (!hasSupportedAvatarSignature(input)) {
    throw new Error('Unsupported employee avatar format')
  }

  const metadata = await imageProcessor.getMetadata(input)
  if (!metadata?.width || !metadata.height || metadata.width * metadata.height > 40_000_000) {
    throw new Error('Invalid employee avatar dimensions')
  }

  return imageProcessor.process(input, {
    resize: { width: 256, height: 256 },
    fit: 'cover',
    format: 'png',
  })
}

function hasSupportedAvatarSignature(input: Buffer): boolean {
  const isPng = input.length >= 8
    && input.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const isJpeg = input.length >= 3
    && input[0] === 0xff
    && input[1] === 0xd8
    && input[2] === 0xff
  const isWebp = input.length >= 12
    && input.subarray(0, 4).toString('ascii') === 'RIFF'
    && input.subarray(8, 12).toString('ascii') === 'WEBP'
  return isPng || isJpeg || isWebp
}
