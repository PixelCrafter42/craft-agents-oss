/**
 * IPC protocol between the gateway adapter and the Weixin worker subprocess.
 *
 * Transport: newline-delimited JSON over stdin/stdout.
 * - Adapter -> Worker: WorkerCommand
 * - Worker -> Adapter: WorkerEvent
 * - stderr is reserved for logs.
 */

export type WorkerCommand =
  | StartCommand
  | SendTextCommand
  | SendFileCommand
  | ShutdownCommand

export interface StartCommand {
  type: 'start'
  /** Root state dir used as OPENCLAW_STATE_DIR for weixin-agent-sdk. */
  stateDir: string
}

export interface SendTextCommand {
  id: string
  type: 'send_text'
  channelId: string
  text: string
}

export interface SendFileCommand {
  id: string
  type: 'send_file'
  channelId: string
  dataBase64: string
  filename: string
  caption?: string
}

export interface ShutdownCommand {
  type: 'shutdown'
}

export type WorkerEvent =
  | ReadyEvent
  | QrEvent
  | ConnectedEvent
  | DisconnectedEvent
  | IncomingEvent
  | SendResultEvent
  | ErrorEvent
  | UnavailableEvent

export interface ReadyEvent {
  type: 'ready'
  buildId?: string
  gitSha?: string
}

export interface QrEvent {
  type: 'qr'
  qr: string
}

export interface ConnectedEvent {
  type: 'connected'
  accountId?: string
  userId?: string
  name?: string
}

export interface DisconnectedEvent {
  type: 'disconnected'
  reason?: string
}

export interface IncomingEvent {
  type: 'incoming'
  channelId: string
  messageId: string
  senderId: string
  senderName?: string
  text: string
  timestamp: number
  media?: {
    type: 'image' | 'audio' | 'video' | 'file'
    filePath: string
    mimeType: string
    fileName?: string
  }
}

export interface SendResultEvent {
  type: 'send_result'
  id: string
  ok: boolean
  messageId?: string
  error?: string
}

export interface ErrorEvent {
  type: 'error'
  message: string
}

export interface UnavailableEvent {
  type: 'unavailable'
  reason: 'node_version' | 'login_failed' | 'sdk_start_failed' | 'unknown'
  message: string
}

export function encodeMessage(msg: WorkerCommand | WorkerEvent): string {
  return JSON.stringify(msg) + '\n'
}

export function parseFrames<T>(buffer: string): { messages: T[]; rest: string } {
  const messages: T[] = []
  let rest = buffer
  while (true) {
    const nl = rest.indexOf('\n')
    if (nl === -1) break
    const line = rest.slice(0, nl).trim()
    rest = rest.slice(nl + 1)
    if (!line) continue
    try {
      messages.push(JSON.parse(line) as T)
    } catch {
      // Keep the stream alive if a malformed line slips through.
    }
  }
  return { messages, rest }
}
