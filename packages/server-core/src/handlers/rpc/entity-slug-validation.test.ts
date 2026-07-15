import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerFn, RpcServer } from '../../transport/types'
import type { HandlerDeps } from '../handler-deps'
import { registerEmployeesHandlers } from './employees'
import { registerProjectsHandlers } from './projects'

const context = { clientId: 'test', workspaceId: null, webContentsId: null }

function createHarness() {
  const handlers = new Map<string, HandlerFn>()
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  const deps = {
    platform: {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    },
  } as unknown as HandlerDeps

  registerProjectsHandlers(server, deps)
  registerEmployeesHandlers(server, deps)
  return handlers
}

describe('project and employee RPC slug validation', () => {
  it('rejects project traversal before resolving a workspace or touching storage', async () => {
    const handlers = createHarness()
    const calls: Array<[string, unknown[]]> = [
      [RPC_CHANNELS.projects.UPDATE, ['missing-workspace', '..', {}]],
      [RPC_CHANNELS.projects.DELETE, ['missing-workspace', '../victim']],
      [RPC_CHANNELS.projects.LIST_ASSETS, ['missing-workspace', '/tmp/victim']],
      [RPC_CHANNELS.projects.UPLOAD_ASSET, ['missing-workspace', '..', { filename: 'x', text: 'x' }]],
      [RPC_CHANNELS.projects.DELETE_ASSET, ['missing-workspace', '..', 'x']],
    ]

    for (const [channel, args] of calls) {
      await expect(handlers.get(channel)!(context, ...args)).rejects.toThrow('Invalid project slug')
    }
  })

  it('rejects employee traversal before resolving a workspace or touching storage', async () => {
    const handlers = createHarness()
    const calls: Array<[string, unknown[]]> = [
      [RPC_CHANNELS.employees.UPDATE, ['missing-workspace', '..', {}]],
      [RPC_CHANNELS.employees.DELETE, ['missing-workspace', '../victim']],
      [RPC_CHANNELS.employees.UPDATE_AVATAR, ['missing-workspace', '..', 'eA==']],
      [RPC_CHANNELS.employees.DELETE_AVATAR, ['missing-workspace', '../victim']],
      [RPC_CHANNELS.employees.UPDATE_DEFINITION, ['missing-workspace', '/tmp/victim', 'x']],
      [RPC_CHANNELS.employees.UPDATE_MEMORY, ['missing-workspace', '..', 'x']],
    ]

    for (const [channel, args] of calls) {
      await expect(handlers.get(channel)!(context, ...args)).rejects.toThrow('Invalid employee slug')
    }
  })
})
