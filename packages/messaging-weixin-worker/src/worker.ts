/**
 * Weixin worker subprocess entry.
 *
 * The long-polling SDK keeps global state under OPENCLAW_STATE_DIR and caches
 * context tokens in process memory. Running it in a child process isolates that
 * state per workspace and keeps the gateway process independent.
 *
 * QR login helpers below are adapted from wong2/weixin-agent-sdk v0.5.0
 * (MIT). The public SDK `login()` only prints terminal QR output, so the worker
 * reimplements the minimal QR start/poll/persist path needed for desktop UI.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import {
  encodeMessage,
  parseFrames,
  type WorkerCommand,
  type WorkerEvent,
} from './protocol'

declare const __WEIXIN_WORKER_BUILD_ID__: string
declare const __WEIXIN_WORKER_GIT_SHA__: string

const WORKER_BUILD_ID =
  typeof __WEIXIN_WORKER_BUILD_ID__ !== 'undefined'
    ? __WEIXIN_WORKER_BUILD_ID__
    : 'dev-unbundled'
const WORKER_GIT_SHA =
  typeof __WEIXIN_WORKER_GIT_SHA__ !== 'undefined'
    ? __WEIXIN_WORKER_GIT_SHA__
    : 'dev-unbundled'

const FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com'
const DEFAULT_ILINK_BOT_TYPE = '3'
const GET_QRCODE_TIMEOUT_MS = 5_000
const QR_LONG_POLL_TIMEOUT_MS = 35_000
const LOGIN_TTL_MS = 5 * 60_000
const LOGIN_TIMEOUT_MS = 480_000
const MAX_QR_REFRESH_COUNT = 3

type WeixinSdk = typeof import('weixin-agent-sdk')
type WeixinBot = InstanceType<WeixinSdk['Bot']>

interface AccountData {
  token?: string
  savedAt?: string
  baseUrl?: string
  userId?: string
}

interface SessionState {
  stateDir: string
  accountId: string
  userId: string
  bot: WeixinBot
  abortController: AbortController
  monitor: Promise<void>
}

interface QrResponse {
  qrcode: string
  qrcode_img_content: string
}

interface QrStatusResponse {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect'
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
  redirect_host?: string
}

interface LoginResult {
  accountId: string
  userId: string
}

let session: SessionState | null = null
let stdinBuffer = ''

function emit(event: WorkerEvent): void {
  process.stdout.write(encodeMessage(event))
}

function log(...args: unknown[]): void {
  process.stderr.write('[weixin-worker] ' + args.map(String).join(' ') + '\n')
}

function ensureNode22(): void {
  const major = Number(process.versions.node.split('.')[0])
  if (!Number.isFinite(major) || major < 22) {
    throw new Error(`Weixin connector requires Node.js >=22; current ${process.versions.node}`)
  }
}

function normalizeAccountId(raw: string): string {
  return raw.trim().toLowerCase().replace(/[@.]/g, '-')
}

function weixinStateDir(stateDir: string): string {
  return path.join(stateDir, 'openclaw-weixin')
}

function accountIndexPath(stateDir: string): string {
  return path.join(weixinStateDir(stateDir), 'accounts.json')
}

function accountsDir(stateDir: string): string {
  return path.join(weixinStateDir(stateDir), 'accounts')
}

function accountPath(stateDir: string, accountId: string): string {
  return path.join(accountsDir(stateDir), `${accountId}.json`)
}

function listAccountIds(stateDir: string): string[] {
  try {
    const raw = readFileSync(accountIndexPath(stateDir), 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      : []
  } catch {
    return []
  }
}

function loadAccount(stateDir: string, accountId: string): AccountData | null {
  try {
    const file = accountPath(stateDir, accountId)
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf-8')) as AccountData
  } catch {
    return null
  }
}

function findConfiguredAccount(stateDir: string): { accountId: string; data: AccountData } | null {
  for (const id of listAccountIds(stateDir)) {
    const data = loadAccount(stateDir, id)
    if (data?.token?.trim() && data.userId?.trim()) {
      return { accountId: id, data }
    }
  }
  return null
}

function saveAccount(
  stateDir: string,
  rawAccountId: string,
  update: { token?: string; baseUrl?: string; userId?: string },
): string {
  const accountId = normalizeAccountId(rawAccountId)
  mkdirSync(accountsDir(stateDir), { recursive: true })
  const data: AccountData = {
    token: update.token?.trim() || undefined,
    savedAt: new Date().toISOString(),
    baseUrl: update.baseUrl?.trim() || undefined,
    userId: update.userId?.trim() || undefined,
  }
  writeFileSync(accountPath(stateDir, accountId), JSON.stringify(data, null, 2), 'utf-8')
  try {
    process.platform !== 'win32' && chmodSync(accountPath(stateDir, accountId), 0o600)
  } catch {
    // best effort
  }
  mkdirSync(weixinStateDir(stateDir), { recursive: true })
  writeFileSync(accountIndexPath(stateDir), JSON.stringify([accountId], null, 2), 'utf-8')
  return accountId
}

function buildHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
  }
}

async function getJson<T>(
  baseUrl: string,
  endpoint: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const url = new URL(endpoint, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: buildHeaders(),
      signal: controller.signal,
    })
    const raw = await res.text()
    if (!res.ok) throw new Error(`${res.status}: ${raw}`)
    return JSON.parse(raw) as T
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

async function fetchQr(signal: AbortSignal): Promise<QrResponse> {
  return getJson<QrResponse>(
    FIXED_BASE_URL,
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(DEFAULT_ILINK_BOT_TYPE)}`,
    GET_QRCODE_TIMEOUT_MS,
    signal,
  )
}

async function pollQrStatus(
  baseUrl: string,
  qrcode: string,
  signal: AbortSignal,
): Promise<QrStatusResponse> {
  try {
    return await getJson<QrStatusResponse>(
      baseUrl,
      `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      QR_LONG_POLL_TIMEOUT_MS,
      signal,
    )
  } catch (err) {
    if (signal.aborted) throw err
    if (err instanceof Error && err.name === 'AbortError') return { status: 'wait' }
    log('QR status poll failed, retrying:', err instanceof Error ? err.message : String(err))
    return { status: 'wait' }
  }
}

async function startLogin(stateDir: string, signal: AbortSignal): Promise<LoginResult> {
  let qr = await fetchQr(signal)
  emit({ type: 'qr', qr: qr.qrcode_img_content })

  const deadline = Date.now() + LOGIN_TIMEOUT_MS
  let currentBaseUrl = FIXED_BASE_URL
  let refreshCount = 1

  while (Date.now() < deadline && !signal.aborted) {
    const status = await pollQrStatus(currentBaseUrl, qr.qrcode, signal)

    if (status.status === 'scaned_but_redirect') {
      if (status.redirect_host) currentBaseUrl = `https://${status.redirect_host}`
    } else if (status.status === 'expired') {
      refreshCount += 1
      if (refreshCount > MAX_QR_REFRESH_COUNT) {
        throw new Error('Login timed out: QR code expired too many times.')
      }
      qr = await fetchQr(signal)
      currentBaseUrl = FIXED_BASE_URL
      emit({ type: 'qr', qr: qr.qrcode_img_content })
    } else if (status.status === 'confirmed') {
      if (!status.ilink_bot_id || !status.bot_token || !status.ilink_user_id) {
        throw new Error('Login confirmed but required account fields were missing.')
      }
      const accountId = saveAccount(stateDir, status.ilink_bot_id, {
        token: status.bot_token,
        baseUrl: status.baseurl,
        userId: status.ilink_user_id,
      })
      return { accountId, userId: status.ilink_user_id }
    }

    await sleep(1000, signal)
  }

  throw new Error(signal.aborted ? 'Login aborted.' : 'Login timed out.')
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error('aborted'))
      },
      { once: true },
    )
  })
}

async function loadSdk(): Promise<WeixinSdk> {
  return import('weixin-agent-sdk')
}

async function handleStart(stateDir: string): Promise<void> {
  if (session) {
    emit({ type: 'error', message: 'Weixin worker already started' })
    return
  }

  try {
    ensureNode22()
  } catch (err) {
    emit({
      type: 'unavailable',
      reason: 'node_version',
      message: err instanceof Error ? err.message : String(err),
    })
    return
  }

  emit({ type: 'ready', buildId: WORKER_BUILD_ID, gitSha: WORKER_GIT_SHA })
  mkdirSync(stateDir, { recursive: true })
  process.env.OPENCLAW_STATE_DIR = stateDir

  const controller = new AbortController()
  let account = findConfiguredAccount(stateDir)
  if (!account) {
    try {
      const login = await startLogin(stateDir, controller.signal)
      account = { accountId: login.accountId, data: { userId: login.userId } }
    } catch (err) {
      emit({
        type: 'unavailable',
        reason: 'login_failed',
        message: err instanceof Error ? err.message : String(err),
      })
      return
    }
  }

  const userId = account.data.userId?.trim()
  if (!userId) {
    emit({
      type: 'unavailable',
      reason: 'login_failed',
      message: 'Stored Weixin account is missing userId. Forget the platform and reconnect.',
    })
    return
  }

  try {
    const sdk = await loadSdk()
    const bot = sdk.start(
      {
        async chat(req) {
          if (req.conversationId !== userId) {
            log('ignoring non-self Weixin conversation:', req.conversationId)
            return {}
          }
          emit({
            type: 'incoming',
            channelId: req.conversationId,
            messageId: `weixin-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            senderId: req.conversationId,
            text: req.text,
            timestamp: Date.now(),
            media: req.media
              ? {
                  type: req.media.type,
                  filePath: req.media.filePath,
                  mimeType: req.media.mimeType,
                  fileName: req.media.fileName,
                }
              : undefined,
          })
          return {}
        },
      },
      {
        accountId: account.accountId,
        abortSignal: controller.signal,
        log: (message) => log(message),
      },
    )

    const monitor = bot.wait()
    session = {
      stateDir,
      accountId: account.accountId,
      userId,
      bot,
      abortController: controller,
      monitor,
    }
    emit({ type: 'connected', accountId: account.accountId, userId, name: account.accountId })
    monitor.then(
      () => {
        emit({ type: 'disconnected', reason: 'monitor stopped' })
        session = null
      },
      (err) => {
        if (controller.signal.aborted) return
        emit({ type: 'disconnected', reason: err instanceof Error ? err.message : String(err) })
        session = null
      },
    )
  } catch (err) {
    emit({
      type: 'unavailable',
      reason: 'sdk_start_failed',
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

async function handleSendText(id: string, channelId: string, text: string): Promise<void> {
  if (!session) {
    emit({ type: 'send_result', id, ok: false, error: 'Not connected' })
    return
  }
  if (channelId !== session.userId) {
    emit({ type: 'send_result', id, ok: false, error: 'Weixin v1 only sends to the logged-in user channel' })
    return
  }
  try {
    await session.bot.sendMessage(text)
    emit({ type: 'send_result', id, ok: true, messageId: id })
  } catch (err) {
    emit({ type: 'send_result', id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleSendFile(
  id: string,
  channelId: string,
  dataBase64: string,
  filename: string,
  caption?: string,
): Promise<void> {
  if (!session) {
    emit({ type: 'send_result', id, ok: false, error: 'Not connected' })
    return
  }
  if (channelId !== session.userId) {
    emit({ type: 'send_result', id, ok: false, error: 'Weixin v1 only sends to the logged-in user channel' })
    return
  }

  const safeName = path.basename(filename).replace(/[^\w.\-]+/g, '_') || 'attachment.bin'
  const filePath = path.join(tmpdir(), `craft-agent-weixin-${Date.now()}-${safeName}`)
  try {
    writeFileSync(filePath, Buffer.from(dataBase64, 'base64'))
    await session.bot.sendMessage({
      text: caption,
      media: {
        type: 'file',
        url: filePath,
        fileName: filename,
      },
    })
    emit({ type: 'send_result', id, ok: true, messageId: id })
  } catch (err) {
    emit({ type: 'send_result', id, ok: false, error: err instanceof Error ? err.message : String(err) })
  } finally {
    await rm(filePath, { force: true }).catch(() => {})
  }
}

async function shutdown(): Promise<void> {
  if (session) {
    session.abortController.abort()
    session = null
  }
  process.exit(0)
}

async function handleCommand(cmd: WorkerCommand): Promise<void> {
  switch (cmd.type) {
    case 'start':
      await handleStart(cmd.stateDir)
      return
    case 'send_text':
      await handleSendText(cmd.id, cmd.channelId, cmd.text)
      return
    case 'send_file':
      await handleSendFile(cmd.id, cmd.channelId, cmd.dataBase64, cmd.filename, cmd.caption)
      return
    case 'shutdown':
      await shutdown()
      return
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk
  const { messages, rest } = parseFrames<WorkerCommand>(stdinBuffer)
  stdinBuffer = rest
  for (const msg of messages) void handleCommand(msg)
})

process.stdin.on('end', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
