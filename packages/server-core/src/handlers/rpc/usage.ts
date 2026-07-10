import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { loadWorkspaceProjects } from '@craft-agent/shared/projects'
import { listSessions } from '@craft-agent/shared/sessions'
import {
  aggregateUsageRecords,
  readLegacyUsageEstimates,
  readUsageRecords,
  type UsageQuery,
  type UsageReport,
} from '@craft-agent/shared/usage'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.usage.GET,
] as const

function defaultUsageWindow(): { from: number; to: number } {
  const to = Date.now()
  const from = to - 30 * 24 * 60 * 60 * 1000
  return { from, to }
}

export function registerUsageHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger

  server.handle(RPC_CHANNELS.usage.GET, async (_ctx, workspaceId: string, query: UsageQuery = {}): Promise<UsageReport> => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)

    const fallbackWindow = defaultUsageWindow()
    const from = typeof query.from === 'number' ? query.from : fallbackWindow.from
    const to = typeof query.to === 'number' ? query.to : fallbackWindow.to
    const timezone = query.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

    try {
      const ledgerRecords = readUsageRecords(workspace.rootPath, { from, to })
      const ledgerSessionIds = new Set(ledgerRecords.map(record => record.sessionId))
      const legacyRecords = query.includeLegacy === false
        ? []
        : readLegacyUsageEstimates(workspace.rootPath, ledgerSessionIds, { from, to })
      const records = [...ledgerRecords, ...legacyRecords]

      const sessions = listSessions(workspace.rootPath)
      const existingSessionIds = new Set(sessions.map(session => session.id))
      const sessionLabels = new Map(sessions.map(session => [session.id, session.name || session.id]))
      const projects = loadWorkspaceProjects(workspace.rootPath)
      const projectLabels = new Map(projects.map(project => [project.config.id, project.config.name]))

      return aggregateUsageRecords(records, {
        from,
        to,
        timezone,
        existingSessionIds,
        sessionLabels,
        projectLabels,
      })
    } catch (error) {
      log.error(`USAGE_GET failed for workspace ${workspaceId}:`, error)
      throw error
    }
  })
}

