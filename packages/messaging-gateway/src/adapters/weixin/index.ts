/**
 * WeixinAdapter — out-of-process adapter around weixin-agent-sdk.
 *
 * The SDK stores auth/sync buffers in OPENCLAW_STATE_DIR and keeps
 * context-token state in process memory, so it runs in a Node subprocess.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { Buffer } from 'node:buffer'
import {
  encodeMessage,
  parseFrames,
  type WorkerCommand,
  type WorkerEvent,
} from '@craft-agent/messaging-weixin-worker'
import type {
  PlatformAdapter,
  PlatformConfig,
  AdapterCapabilities,
  IncomingMessage,
  IncomingAttachment,
  SentMessage,
  InlineButton,
  ButtonPress,
  MessagingLogger,
} from '../../types'

const NOOP_LOGGER: MessagingLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
}

const DEFAULT_SEND_TIMEOUT_MS = 30_000

type PendingEntry = {
  resolve: (r: { ok: boolean; messageId?: string; error?: string }) => void
  timer: ReturnType<typeof setTimeout>
}

export interface WeixinConfig extends PlatformConfig {
  /** Absolute path to the bundled worker entry. */
  workerEntry: string
  /** Root state dir passed to the worker as OPENCLAW_STATE_DIR. */
  stateDir: string
  /** Node binary path. Defaults to process.execPath. */
  nodeBin?: string
  sendTimeoutMs?: number
}

export type WeixinEvent =
  | { type: 'qr'; qr: string }
  | { type: 'connected'; accountId?: string; userId?: string; name?: string }
  | { type: 'disconnected'; reason?: string }
  | { type: 'unavailable'; reason: string; message: string }
  | { type: 'error'; message: string }

type EventHandler = (event: WeixinEvent) => void

export class WeixinAdapter implements PlatformAdapter {
  readonly platform = 'weixin' as const
  readonly capabilities: AdapterCapabilities = {
    messageEditing: false,
    inlineButtons: false,
    maxButtons: 0,
    maxMessageLength: 4096,
    markdown: 'whatsapp',
    webhookSupport: false,
  }

  private proc: ChildProcess | null = null
  private stdoutBuffer = ''
  private connected = false
  private started = false
  private nextCmdId = 1
  private sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS
  private log: MessagingLogger = NOOP_LOGGER
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null
  private buttonHandler: ((press: ButtonPress) => Promise<void>) | null = null
  private eventHandlers = new Set<EventHandler>()
  private pending = new Map<string, PendingEntry>()

  async initialize(config: PlatformConfig): Promise<void> {
    const cfg = config as WeixinConfig
    if (!cfg.workerEntry) throw new Error('Weixin: workerEntry path is required')
    if (!cfg.stateDir) throw new Error('Weixin: stateDir path is required')
    if (this.proc) throw new Error('Weixin adapter already initialized')

    this.log = (cfg.logger ?? NOOP_LOGGER).child({
      component: 'weixin-adapter',
      platform: 'weixin',
    })
    if (cfg.sendTimeoutMs !== undefined && cfg.sendTimeoutMs > 0) {
      this.sendTimeoutMs = cfg.sendTimeoutMs
    }

    const nodeBin = cfg.nodeBin ?? process.execPath
    this.log.info('starting Weixin worker', {
      event: 'weixin_worker_starting',
      workerEntry: cfg.workerEntry,
      stateDir: cfg.stateDir,
      nodeBin,
    })

    this.proc = spawn(nodeBin, [cfg.workerEntry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        OPENCLAW_STATE_DIR: cfg.stateDir,
      },
    })

    this.proc.stdout?.setEncoding('utf8')
    this.proc.stdout?.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk
      const { messages, rest } = parseFrames<WorkerEvent>(this.stdoutBuffer)
      this.stdoutBuffer = rest
      for (const ev of messages) this.onWorkerEvent(ev)
    })

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString('utf8').split('\n').filter(Boolean)
      for (const line of lines) {
        this.log.warn('Weixin worker stderr', {
          event: 'weixin_worker_stderr',
          line,
        })
      }
    })

    this.proc.on('exit', (code, signal) => {
      this.connected = false
      this.started = false
      this.proc = null
      this.drainPending(`worker exited with code ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}`)
      this.log.warn('Weixin worker exited', {
        event: 'weixin_worker_exited',
        code,
        signal,
      })
      if (code !== 0) {
        this.fireEvent({
          type: 'error',
          message: `Worker exited with code ${code ?? 'null'}`,
        })
      }
    })

    this.sendCommand({ type: 'start', stateDir: cfg.stateDir })
    this.started = true
  }

  async destroy(): Promise<void> {
    if (!this.proc) return
    try {
      this.sendCommand({ type: 'shutdown' })
    } catch (err) {
      this.log.warn('failed to send shutdown to Weixin worker', {
        event: 'weixin_worker_shutdown_signal_failed',
        error: err,
      })
    }
    const proc = this.proc
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          // ignore
        }
        resolve()
      }, 2000)
      proc.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    this.drainPending('adapter destroyed')
    this.proc = null
    this.started = false
    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler
  }

  onButtonPress(handler: (press: ButtonPress) => Promise<void>): void {
    this.buttonHandler = handler
  }

  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  async sendText(channelId: string, text: string): Promise<SentMessage> {
    const id = String(this.nextCmdId++)
    const result = await this.sendWithResult({ id, type: 'send_text', channelId, text })
    if (!result.ok) throw new Error(result.error ?? 'Send failed')
    return {
      platform: 'weixin',
      channelId,
      messageId: result.messageId ?? id,
    }
  }

  async editMessage(): Promise<void> {
    throw new Error('Weixin edit not supported in this adapter')
  }

  async sendButtons(channelId: string, text: string, buttons: InlineButton[]): Promise<SentMessage> {
    const numbered = buttons.map((b, i) => `${i + 1}. ${b.label}`).join('\n')
    const combined = numbered ? `${text}\n\n${numbered}` : text
    return this.sendText(channelId, combined)
  }

  async sendTyping(): Promise<void> {
    // The SDK manages typing while processing inbound messages; outbound
    // renderer status pings are intentionally omitted.
  }

  async sendFile(
    channelId: string,
    file: Buffer,
    filename: string,
    caption?: string,
  ): Promise<SentMessage> {
    const id = String(this.nextCmdId++)
    const result = await this.sendWithResult({
      id,
      type: 'send_file',
      channelId,
      dataBase64: file.toString('base64'),
      filename,
      caption,
    })
    if (!result.ok) throw new Error(result.error ?? 'Send failed')
    return {
      platform: 'weixin',
      channelId,
      messageId: result.messageId ?? id,
    }
  }

  private sendCommand(cmd: WorkerCommand): void {
    if (!this.proc || !this.proc.stdin?.writable) {
      throw new Error('Weixin worker is not running')
    }
    this.proc.stdin.write(encodeMessage(cmd))
  }

  private sendWithResult(
    cmd: Extract<WorkerCommand, { id: string }>,
  ): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(cmd.id)) {
          this.log.warn('Weixin send timed out', {
            event: 'weixin_send_timeout',
            commandId: cmd.id,
            commandType: cmd.type,
            timeoutMs: this.sendTimeoutMs,
          })
          resolve({ ok: false, error: `send timed out after ${this.sendTimeoutMs}ms` })
        }
      }, this.sendTimeoutMs)
      this.pending.set(cmd.id, { resolve, timer })
      try {
        this.sendCommand(cmd)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(cmd.id)
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    })
  }

  private drainPending(reason: string): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.resolve({ ok: false, error: reason })
    }
    this.pending.clear()
  }

  private fireEvent(event: WeixinEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event)
      } catch {
        // isolate handler errors
      }
    }
  }

  private onWorkerEvent(ev: WorkerEvent): void {
    switch (ev.type) {
      case 'ready':
        this.log.info('Weixin worker ready', {
          event: 'weixin_worker_ready',
          buildId: ev.buildId,
          gitSha: ev.gitSha,
        })
        return
      case 'qr':
        this.fireEvent({ type: 'qr', qr: ev.qr })
        return
      case 'connected':
        this.connected = true
        this.fireEvent({
          type: 'connected',
          accountId: ev.accountId,
          userId: ev.userId,
          name: ev.name,
        })
        return
      case 'disconnected':
        this.connected = false
        this.fireEvent({ type: 'disconnected', reason: ev.reason })
        return
      case 'incoming':
        if (this.messageHandler) {
          const attachments: IncomingAttachment[] | undefined = ev.media
            ? [{
                type: mapMediaType(ev.media.type),
                fileId: ev.media.filePath,
                fileName: ev.media.fileName,
                mimeType: ev.media.mimeType,
                localPath: ev.media.filePath,
              }]
            : undefined
          void this.messageHandler({
            platform: 'weixin',
            channelId: ev.channelId,
            messageId: ev.messageId,
            senderId: ev.senderId,
            senderName: ev.senderName,
            text: ev.text,
            attachments,
            timestamp: ev.timestamp,
            raw: ev,
          })
        }
        return
      case 'send_result': {
        const entry = this.pending.get(ev.id)
        if (entry) {
          clearTimeout(entry.timer)
          this.pending.delete(ev.id)
          entry.resolve({ ok: ev.ok, messageId: ev.messageId, error: ev.error })
        }
        return
      }
      case 'error':
        this.fireEvent({ type: 'error', message: ev.message })
        return
      case 'unavailable':
        this.fireEvent({ type: 'unavailable', reason: ev.reason, message: ev.message })
        return
    }
  }
}

function mapMediaType(type: 'image' | 'audio' | 'video' | 'file'): IncomingAttachment['type'] {
  switch (type) {
    case 'image':
      return 'photo'
    case 'audio':
      return 'audio'
    case 'video':
      return 'video'
    case 'file':
      return 'document'
  }
}
