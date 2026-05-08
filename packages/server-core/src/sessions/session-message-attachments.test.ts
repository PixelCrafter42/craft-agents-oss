import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileAttachment } from '@craft-agent/shared/protocol'
import type { PlatformServices } from '@craft-agent/server-core/runtime'
import { SessionManager, setSessionPlatform } from './SessionManager'

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
}

let workspaceRoot: string

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-session-attachments-'))
  setSessionPlatform({
    appRootPath: workspaceRoot,
    resourcesPath: workspaceRoot,
    isPackaged: false,
    appVersion: 'test',
    imageProcessor: {
      getMetadata: async () => ({ width: 1, height: 1 }),
      process: async () => Buffer.from(TINY_PNG_B64, 'base64'),
    },
    logger,
    isDebugMode: false,
  } satisfies PlatformServices)
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
})

describe('SessionManager message attachments', () => {
  it('materializes model attachments into stored attachments for UI previews', async () => {
    const manager = new SessionManager()
    const attachment: FileAttachment = {
      type: 'image',
      path: join(workspaceRoot, 'incoming.png'),
      name: 'incoming.png',
      mimeType: 'image/png',
      base64: TINY_PNG_B64,
      size: Buffer.byteLength(TINY_PNG_B64, 'base64'),
    }

    const stored = await (
      manager as unknown as {
        materializeStoredAttachmentsForMessage(
          managed: unknown,
          attachments?: FileAttachment[],
        ): Promise<Array<{ thumbnailBase64?: string; storedPath: string; name: string }> | undefined>
      }
    ).materializeStoredAttachmentsForMessage(
      { id: 'sess-test', workspace: { id: 'ws-test', rootPath: workspaceRoot } },
      [attachment],
    )

    expect(stored).toHaveLength(1)
    expect(stored![0]!.name).toBe('incoming.png')
    expect(stored![0]!.storedPath).toContain('incoming.png')
    expect(stored![0]!.thumbnailBase64).toBe(TINY_PNG_B64)
  })
})
