import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync, unlinkSync } from 'node:fs'
import { extname } from 'node:path'
import { TelegramAdapter } from './index'

const originalFetch = globalThis.fetch
const tempPaths: string[] = []

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const path of tempPaths.splice(0)) {
    try {
      unlinkSync(path)
    } catch {
      // best-effort temp cleanup
    }
  }
})

describe('TelegramAdapter native voice download', () => {
  it('writes the response as byte-exact .oga data when Telegram omits the extension', async () => {
    const voiceBytes = Buffer.from([
      0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0xff, 0xfe, 0x80, 0x00, 0xc3, 0x28,
    ])
    let requestedUrl = ''
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = String(input)
      return new Response(voiceBytes)
    }) as typeof globalThis.fetch

    const adapter = new TelegramAdapter()
    ;(adapter as unknown as {
      bot: {
        token: string
        api: { getFile: (fileId: string) => Promise<{ file_path: string; file_size: number }> }
      }
    }).bot = {
      token: 'TEST_TOKEN',
      api: {
        getFile: async () => ({
          file_path: 'voice/file_123',
          file_size: voiceBytes.byteLength,
        }),
      },
    }

    const downloaded = await (
      adapter as unknown as {
        downloadToTemp(
          fileId: string,
          fallbackName: string,
          mimeType: string,
        ): Promise<{ localPath: string; fileName: string; fileSize: number }>
      }
    ).downloadToTemp('voice-file-id', 'voice-123', 'audio/ogg')
    tempPaths.push(downloaded.localPath)

    expect(requestedUrl).toBe('https://api.telegram.org/file/botTEST_TOKEN/voice/file_123')
    expect(downloaded.fileName).toBe('voice-123.oga')
    expect(extname(downloaded.localPath)).toBe('.oga')
    expect(downloaded.fileSize).toBe(voiceBytes.byteLength)
    expect(readFileSync(downloaded.localPath)).toEqual(voiceBytes)
  })
})
