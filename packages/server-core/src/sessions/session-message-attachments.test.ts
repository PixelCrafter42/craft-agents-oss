import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

  it('stores Telegram voice bytes and exposes the stored path to the agent attachment', async () => {
    const manager = new SessionManager()
    const voiceBytes = Buffer.from([
      0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0xff, 0xfe, 0x80, 0x00, 0xc3, 0x28,
    ])
    const attachment: FileAttachment = {
      type: 'audio',
      path: join(workspaceRoot, 'voice.oga'),
      name: 'voice-123.oga',
      mimeType: 'audio/ogg',
      base64: voiceBytes.toString('base64'),
      size: voiceBytes.byteLength,
    }

    const stored = await (
      manager as unknown as {
        materializeStoredAttachmentsForMessage(
          managed: unknown,
          attachments?: FileAttachment[],
        ): Promise<Array<{ type: string; mimeType: string; size: number; storedPath: string }> | undefined>
      }
    ).materializeStoredAttachmentsForMessage(
      { id: 'sess-voice', workspace: { id: 'ws-test', rootPath: workspaceRoot } },
      [attachment],
    )

    expect(stored).toHaveLength(1)
    expect(stored![0]).toMatchObject({
      type: 'audio',
      mimeType: 'audio/ogg',
      size: voiceBytes.byteLength,
    })
    expect(readFileSync(stored![0]!.storedPath)).toEqual(voiceBytes)
    expect(attachment.storedPath).toBe(stored![0]!.storedPath)
  })
})
