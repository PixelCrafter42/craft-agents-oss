import { beforeEach, describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { registerSessionsHandlers } from '@craft-agent/server-core/handlers/rpc'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '@craft-agent/server-core/handlers'

type HandlerFn = (ctx: { clientId: string }, ...args: any[]) => Promise<any> | any

function createServer(handlers: Map<string, HandlerFn>): RpcServer {
  return {
    handle(channel, handler) {
      handlers.set(channel, handler as HandlerFn)
    },
    push() {},
    async invokeClient() {
      return null
    },
  }
}

function createDeps(options: {
  workingDirectory?: string
  sessionPath: string
  onOpenPath?: (path: string) => void
  onShowItemInFolder?: (path: string) => void
}): HandlerDeps {
  return {
    sessionManager: {
      getSession: async (sessionId: string) => ({
        id: sessionId,
        workingDirectory: options.workingDirectory,
      }),
      getSessionPath: () => options.sessionPath,
    } as unknown as HandlerDeps['sessionManager'],
    platform: {
      appRootPath: '',
      resourcesPath: '',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      imageProcessor: {
        getMetadata: async () => null,
        process: async () => Buffer.from(''),
      },
      openPath: options.onOpenPath ? async (path: string) => options.onOpenPath?.(path) : undefined,
      showItemInFolder: options.onShowItemInFolder,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
    },
    oauthFlowStore: {
      store: () => {},
      getByState: () => null,
      remove: () => {},
      cleanup: () => {},
      dispose: () => {},
      get size() { return 0 },
    } as unknown as HandlerDeps['oauthFlowStore'],
  }
}

describe('sessions command handlers', () => {
  const handlers = new Map<string, HandlerFn>()

  beforeEach(() => {
    handlers.clear()
  })

  it('opens the session working directory when showInFinder is requested', async () => {
    const opened: string[] = []
    const workingDirectory = '/Users/test/project'
    const sessionPath = '/Users/test/.craft-agent/workspaces/ws/sessions/session-a'

    registerSessionsHandlers(createServer(handlers), createDeps({
      workingDirectory,
      sessionPath,
      onOpenPath: (path) => opened.push(path),
    }))

    const command = handlers.get(RPC_CHANNELS.sessions.COMMAND)
    expect(command).toBeTruthy()

    await command!({ clientId: 'client-a' }, 'session-a', { type: 'showInFinder' })

    expect(opened).toEqual([workingDirectory])
  })

  it('opens the session folder when showInFinder has no working directory', async () => {
    const opened: string[] = []
    const sessionPath = '/Users/test/.craft-agent/workspaces/ws/sessions/session-a'

    registerSessionsHandlers(createServer(handlers), createDeps({
      sessionPath,
      onOpenPath: (path) => opened.push(path),
    }))

    const command = handlers.get(RPC_CHANNELS.sessions.COMMAND)
    expect(command).toBeTruthy()

    await command!({ clientId: 'client-a' }, 'session-a', { type: 'showInFinder' })

    expect(opened).toEqual([sessionPath])
  })

  it('reveals the folder when openPath is unavailable', async () => {
    const shown: string[] = []
    const workingDirectory = '/Users/test/project'
    const sessionPath = '/Users/test/.craft-agent/workspaces/ws/sessions/session-a'

    registerSessionsHandlers(createServer(handlers), createDeps({
      workingDirectory,
      sessionPath,
      onShowItemInFolder: (path) => shown.push(path),
    }))

    const command = handlers.get(RPC_CHANNELS.sessions.COMMAND)
    expect(command).toBeTruthy()

    await command!({ clientId: 'client-a' }, 'session-a', { type: 'showInFinder' })

    expect(shown).toEqual([workingDirectory])
  })
})
