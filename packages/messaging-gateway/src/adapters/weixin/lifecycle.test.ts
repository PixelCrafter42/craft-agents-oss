import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WeixinAdapter, type WeixinConfig, type WeixinEvent } from './index'
import type { IncomingMessage } from '../../types'

const cleanups: Array<() => void> = []

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wx-adapter-test-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeWorkerScript(kind: 'events' | 'silent'): string {
  const dir = makeTmpDir()
  const path = join(dir, 'fake-weixin-worker.mjs')
  const eventsBody = `
    let buf = ''
    function emit(o) { process.stdout.write(JSON.stringify(o) + '\\n') }
    function handle(msg) {
      if (msg.type === 'start') {
        emit({ type: 'ready', buildId: 'test' })
        emit({ type: 'qr', qr: 'weixin://qr' })
        emit({ type: 'connected', accountId: 'acct-1', userId: 'user-1', name: 'Alice' })
        emit({
          type: 'incoming',
          channelId: 'user-1',
          messageId: 'm-1',
          senderId: 'user-1',
          senderName: 'Alice',
          text: 'hello',
          timestamp: 123,
          media: { type: 'image', filePath: '/tmp/image.jpg', mimeType: 'image/jpeg', fileName: 'image.jpg' },
        })
        emit({ type: 'error', message: 'boom' })
      }
      if (msg.type === 'shutdown') process.exit(0)
    }
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => {
      buf += c
      while (true) {
        const nl = buf.indexOf('\\n')
        if (nl === -1) break
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) handle(JSON.parse(line))
      }
    })
    setInterval(() => {}, 60_000)
  `
  const silentBody = `
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', () => {})
    setInterval(() => {}, 60_000)
  `
  writeFileSync(path, kind === 'events' ? eventsBody : silentBody)
  return path
}

async function makeAdapter(opts: {
  workerScript: string
  sendTimeoutMs?: number
}): Promise<WeixinAdapter> {
  const adapter = new WeixinAdapter()
  const cfg: WeixinConfig = {
    workerEntry: opts.workerScript,
    stateDir: makeTmpDir(),
    nodeBin: process.execPath,
    sendTimeoutMs: opts.sendTimeoutMs,
  }
  await adapter.initialize(cfg)
  return adapter
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for condition')
}

afterEach(() => {
  for (const c of cleanups.splice(0)) {
    try { c() } catch { /* best effort */ }
  }
})

describe('WeixinAdapter lifecycle', () => {
  it('forwards QR, connected, error, and incoming events from the worker', async () => {
    const adapter = new WeixinAdapter()
    const events: WeixinEvent[] = []
    const messages: IncomingMessage[] = []
    adapter.onEvent((event) => events.push(event))
    adapter.onMessage(async (message) => {
      messages.push(message)
    })

    await adapter.initialize({
      workerEntry: writeWorkerScript('events'),
      stateDir: makeTmpDir(),
      nodeBin: process.execPath,
      sendTimeoutMs: 500,
    } satisfies WeixinConfig)

    try {
      await waitFor(() => events.some((e) => e.type === 'error') && messages.length === 1)

      expect(events.find((e) => e.type === 'qr')).toEqual({ type: 'qr', qr: 'weixin://qr' })
      expect(events.find((e) => e.type === 'connected')).toEqual({
        type: 'connected',
        accountId: 'acct-1',
        userId: 'user-1',
        name: 'Alice',
      })
      expect(events.find((e) => e.type === 'error')).toEqual({ type: 'error', message: 'boom' })
      expect(adapter.isConnected()).toBe(true)
      expect(messages[0]).toMatchObject({
        platform: 'weixin',
        channelId: 'user-1',
        senderId: 'user-1',
        text: 'hello',
      })
      expect(messages[0]?.attachments?.[0]).toMatchObject({
        type: 'photo',
        fileId: '/tmp/image.jpg',
        fileName: 'image.jpg',
        mimeType: 'image/jpeg',
        localPath: '/tmp/image.jpg',
      })
    } finally {
      await adapter.destroy()
    }
  })

  it('times out a pending send when the worker never responds', async () => {
    const adapter = await makeAdapter({
      workerScript: writeWorkerScript('silent'),
      sendTimeoutMs: 200,
    })
    try {
      await expect(adapter.sendText('user-1', 'hello')).rejects.toThrow(
        /send timed out after 200ms/,
      )
    } finally {
      await adapter.destroy()
    }
  })
})
