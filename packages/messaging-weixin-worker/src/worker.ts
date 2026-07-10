/**
 * Weixin worker subprocess entry.
 *
 * The long-polling SDK keeps global state under OPENCLAW_STATE_DIR and caches
 * context tokens in process memory. This worker persists the latest context
 * token per account/user so proactive desktop automations can still send after
 * restart.
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
import { loadContextToken, saveContextToken } from './context-token-cache'
import { sendTextWithPersistedFallback } from './send-text'

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
const GET_QRCODE_TIMEOUT_MS = 10_000
const QR_LONG_POLL_TIMEOUT_MS = 35_000
const LOGIN_TTL_MS = 5 * 60_000
const LOGIN_TIMEOUT_MS = 480_000
const MAX_QR_REFRESH_COUNT = 3
const WEIXIN_ILINK_APP_ID = 'bot'
const UPSTREAM_WEIXIN_PROTOCOL_VERSION = '2.4.6'
const WEIXIN_ILINK_CLIENT_VERSION = buildClientVersion(UPSTREAM_WEIXIN_PROTOCOL_VERSION)
const DEFAULT_BOT_AGENT = 'CraftAgent/1.0'

type WeixinSdk = typeof import('weixin-agent-sdk')
type WeixinBot = InstanceType<WeixinSdk['Bot']>
type FetchInput = Parameters<typeof fetch>[0]
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>
type FetchHeaders = FetchInit['headers']
type FetchBody = FetchInit['body']

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
  baseUrl: string
  token?: string
  bot: WeixinBot
  abortController: AbortController
  monitor: Promise<void>
}

interface QrResponse {
  qrcode: string
  qrcode_img_content: string
}

type OutgoingMediaType = 'image' | 'video' | 'file'

interface QrStatusResponse {
  status:
    | 'wait'
    | 'scaned'
    | 'confirmed'
    | 'expired'
    | 'scaned_but_redirect'
    | 'need_verifycode'
    | 'verify_code_blocked'
    | 'binded_redirect'
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
let activeContextTokenScope: { stateDir: string; accountId: string } | null = null
let stdinBuffer = ''
let pendingVerifyCode: ((code: string) => void) | null = null
let fetchCompatibilityPatchInstalled = false

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

function buildClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0))
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
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

function listLocalBotTokens(stateDir: string): string[] {
  const accountIds = listAccountIds(stateDir)
  const tokens: string[] = []
  for (let i = accountIds.length - 1; i >= 0 && tokens.length < 10; i -= 1) {
    const accountId = accountIds[i]
    if (!accountId) continue
    const token = loadAccount(stateDir, accountId)?.token?.trim()
    if (token) tokens.push(token)
  }
  return tokens
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

function buildCommonHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': WEIXIN_ILINK_APP_ID,
    'iLink-App-ClientVersion': String(WEIXIN_ILINK_CLIENT_VERSION),
  }
}

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    ...buildCommonHeaders(),
    'Content-Type': 'application/json',
  }
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`
  return headers
}

function normalizeFetchHeaders(headers: FetchHeaders | undefined, token?: string): Headers {
  const normalized = new Headers(headers)
  // fetch sets Content-Length itself; a stale caller-supplied value breaks the
  // request once `withBaseInfo` rewrites the body.
  normalized.delete('Content-Length')
  normalized.delete('content-length')
  // Apply the standard weixin headers as defaults, never clobbering values the
  // caller already set. Single source of truth: buildHeaders.
  for (const [key, value] of Object.entries(buildHeaders(token))) {
    if (!normalized.has(key)) normalized.set(key, value)
  }
  return normalized
}

function withBaseInfo(body: FetchBody | null | undefined): FetchBody | null | undefined {
  if (typeof body !== 'string') return body
  try {
    const parsed = JSON.parse(body) as { base_info?: Record<string, unknown> }
    parsed.base_info = {
      channel_version: UPSTREAM_WEIXIN_PROTOCOL_VERSION,
      bot_agent: DEFAULT_BOT_AGENT,
      ...parsed.base_info,
    }
    return JSON.stringify(parsed)
  } catch {
    return body
  }
}

function classifyFetchError(err: unknown): { type: string; description: string; code?: string } {
  if (err instanceof Error && err.name === 'AbortError') {
    return { type: 'timeout', description: 'request timeout' }
  }
  const cause = (err as { cause?: unknown }).cause
  const causeCode =
    cause && typeof cause === 'object' && 'code' in cause
      ? String((cause as { code?: unknown }).code ?? '')
      : ''
  const causeText = `${String(cause ?? err ?? '')} ${causeCode}`
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(causeText)) {
    return { type: 'dns', description: 'DNS resolution failed', code: causeCode || undefined }
  }
  if (/ECONNREFUSED/i.test(causeText)) {
    return { type: 'tcp', description: 'TCP connection refused', code: causeCode || undefined }
  }
  if (/UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/i.test(causeText)) {
    return { type: 'tcp', description: 'TCP connection timeout or unreachable', code: causeCode || undefined }
  }
  if (/UND_ERR_SOCKET|SSL|TLS|CERT|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(causeText)) {
    return { type: 'tls', description: 'TLS handshake error', code: causeCode || undefined }
  }
  return { type: 'unknown', description: 'network request failed' }
}

function isWeixinApiUrl(raw: unknown): raw is string {
  return typeof raw === 'string' && /\/ilink\/bot\//.test(raw)
}

function installWeixinFetchCompatibilityPatch(): void {
  if (fetchCompatibilityPatchInstalled) return
  fetchCompatibilityPatchInstalled = true
  const originalFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = (async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    const shouldPatch = isWeixinApiUrl(rawUrl)
    if (!shouldPatch) return originalFetch(input, init)

    const nextInit: RequestInit = { ...init }
    nextInit.headers = normalizeFetchHeaders(init?.headers)
    nextInit.body = withBaseInfo(init?.body) as RequestInit['body']
    try {
      const response = await originalFetch(input, nextInit)
      if (/\/ilink\/bot\/getupdates(?:\?|$)/.test(rawUrl)) {
        await persistContextTokensFromGetUpdates(response.clone()).catch((err) => {
          log('failed to persist context token:', err instanceof Error ? err.message : String(err))
        })
      }
      if (/\/ilink\/bot\/sendmessage(?:\?|$)/.test(rawUrl)) {
        const raw = await response.clone().text().catch(() => '')
        if (raw.trim()) {
          try {
            const parsed = JSON.parse(raw) as { ret?: number; errmsg?: string }
            if (parsed.ret !== undefined && parsed.ret !== 0) {
              throw new Error(`sendMessage ret=${parsed.ret} errmsg=${parsed.errmsg ?? '(none)'}`)
            }
          } catch (err) {
            if (err instanceof Error && err.message.startsWith('sendMessage ret=')) throw err
          }
        }
      }
      return response
    } catch (err) {
      const classified = classifyFetchError(err)
      log(
        `Weixin fetch failed: url=${rawUrl.split('?')[0]} type=${classified.type} ` +
          `description=${classified.description}${classified.code ? ` code=${classified.code}` : ''} error=${
            err instanceof Error ? err.message : String(err)
          }`,
      )
      throw err
    }
  }) as typeof fetch
}

async function persistContextTokensFromGetUpdates(response: { text(): Promise<string> }): Promise<void> {
  const scope = activeContextTokenScope
  if (!scope) return
  const raw = await response.text()
  if (!raw.trim()) return
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return
  }
  const msgs = (parsed as { msgs?: unknown }).msgs
  if (!Array.isArray(msgs)) return
  for (const msg of msgs) {
    const userId = (msg as { from_user_id?: unknown }).from_user_id
    const token = (msg as { context_token?: unknown }).context_token
    if (typeof userId !== 'string' || typeof token !== 'string') continue
    saveContextToken(scope.stateDir, scope.accountId, userId, token)
    log(`[weixin] context token cached for ${userId}`)
  }
}

async function requestJson<T>(params: {
  baseUrl: string
  endpoint: string
  method: 'GET' | 'POST'
  body?: unknown
  timeoutMs: number
  signal?: AbortSignal
  token?: string
}): Promise<T> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  params.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), params.timeoutMs)
  try {
    const url = new URL(params.endpoint, params.baseUrl.endsWith('/') ? params.baseUrl : `${params.baseUrl}/`)
    const res = await fetch(url.toString(), {
      method: params.method,
      // QR login GET endpoints in weixin-agent-sdk are intentionally sent
      // without the bot POST headers. Some iLink edges hang instead of
      // returning an error when unexpected headers/body are present.
      headers: params.method === 'GET' ? undefined : buildHeaders(params.token),
      body: params.method === 'POST' ? JSON.stringify(params.body ?? {}) : undefined,
      signal: controller.signal,
    })
    const raw = await res.text()
    if (!res.ok) throw new Error(`${res.status}: ${raw}`)
    return JSON.parse(raw) as T
  } catch (err) {
    const classified = classifyFetchError(err)
    const endpoint = params.endpoint.split('?')[0]
    throw new Error(
      `Weixin API request failed for ${endpoint}: ${classified.description}` +
        `${classified.code ? ` (${classified.code})` : ''}. ` +
        'Check your network, VPN, or proxy settings and try again.',
      { cause: err },
    )
  } finally {
    clearTimeout(timer)
    params.signal?.removeEventListener('abort', onAbort)
  }
}

async function getJson<T>(
  baseUrl: string,
  endpoint: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return requestJson<T>({ baseUrl, endpoint, method: 'GET', timeoutMs, signal })
}

async function postJson<T>(
  baseUrl: string,
  endpoint: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
  token?: string,
): Promise<T> {
  return requestJson<T>({ baseUrl, endpoint, method: 'POST', body, timeoutMs, signal, token })
}

async function notifyConnection(
  type: 'start' | 'stop',
  account: { token?: string; baseUrl?: string },
): Promise<void> {
  const token = account.token?.trim()
  if (!token) return
  const endpoint = type === 'start' ? 'ilink/bot/msg/notifystart' : 'ilink/bot/msg/notifystop'
  try {
    const resp = await postJson<{ ret?: number; errmsg?: string }>(
      account.baseUrl?.trim() || FIXED_BASE_URL,
      endpoint,
      {},
      10_000,
      undefined,
      token,
    )
    if (resp.ret !== undefined && resp.ret !== 0) {
      log(`notify ${type} returned ret=${resp.ret} errmsg=${resp.errmsg ?? ''}`)
    }
  } catch (err) {
    log(`notify ${type} failed:`, err instanceof Error ? err.message : String(err))
  }
}

async function fetchQr(_stateDir: string, signal: AbortSignal): Promise<QrResponse> {
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
  verifyCode: string | undefined,
  signal: AbortSignal,
): Promise<QrStatusResponse> {
  try {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
    if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`
    return await getJson<QrStatusResponse>(
      baseUrl,
      endpoint,
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

function waitForVerifyCode(retry: boolean, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Login aborted.'))
      return
    }
    emit({
      type: 'verify_code_required',
      retry,
      message: retry
        ? 'The previous verification code did not match. Enter the new code shown in WeChat.'
        : 'Enter the verification code shown in WeChat to continue connecting.',
    })
    const onAbort = () => {
      pendingVerifyCode = null
      reject(new Error('Login aborted.'))
    }
    pendingVerifyCode = (code) => {
      signal.removeEventListener('abort', onAbort)
      pendingVerifyCode = null
      resolve(code)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function startLogin(stateDir: string, signal: AbortSignal): Promise<LoginResult> {
  let qr = await fetchQr(stateDir, signal)
  emit({ type: 'qr', qr: qr.qrcode_img_content })

  const deadline = Date.now() + LOGIN_TIMEOUT_MS
  let currentBaseUrl = FIXED_BASE_URL
  let refreshCount = 1
  let verifyCode: string | undefined
  let verifyRetry = false

  while (Date.now() < deadline && !signal.aborted) {
    const status = await pollQrStatus(currentBaseUrl, qr.qrcode, verifyCode, signal)

    if (status.status === 'scaned_but_redirect') {
      if (status.redirect_host) currentBaseUrl = `https://${status.redirect_host}`
    } else if (status.status === 'scaned') {
      verifyCode = undefined
      verifyRetry = false
    } else if (status.status === 'need_verifycode') {
      verifyCode = await waitForVerifyCode(verifyRetry, signal)
      verifyRetry = true
      continue
    } else if (status.status === 'verify_code_blocked') {
      verifyCode = undefined
      verifyRetry = false
      refreshCount += 1
      if (refreshCount > MAX_QR_REFRESH_COUNT) {
        throw new Error('Login stopped: verification code was rejected too many times.')
      }
      qr = await fetchQr(stateDir, signal)
      currentBaseUrl = FIXED_BASE_URL
      emit({ type: 'qr', qr: qr.qrcode_img_content })
    } else if (status.status === 'binded_redirect') {
      const account = findConfiguredAccount(stateDir)
      if (account) return { accountId: account.accountId, userId: account.data.userId! }
      throw new Error(
        'Weixin reports this OpenClaw client is already connected, but no local credentials were found. Disconnect WeChat and connect again.',
      )
    } else if (status.status === 'expired') {
      refreshCount += 1
      if (refreshCount > MAX_QR_REFRESH_COUNT) {
        throw new Error('Login timed out: QR code expired too many times.')
      }
      qr = await fetchQr(stateDir, signal)
      currentBaseUrl = FIXED_BASE_URL
      verifyCode = undefined
      verifyRetry = false
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
  installWeixinFetchCompatibilityPatch()

  const controller = new AbortController()
  let account = findConfiguredAccount(stateDir)
  if (!account) {
    try {
      const login = await startLogin(stateDir, controller.signal)
      account = {
        accountId: login.accountId,
        data: loadAccount(stateDir, login.accountId) ?? { userId: login.userId },
      }
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
    activeContextTokenScope = { stateDir, accountId: account.accountId }
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
      baseUrl: account.data.baseUrl?.trim() || FIXED_BASE_URL,
      token: account.data.token?.trim() || undefined,
      bot,
      abortController: controller,
      monitor,
    }
    void notifyConnection('start', account.data)
    emit({ type: 'connected', accountId: account.accountId, userId, name: account.accountId })
    monitor.then(
      () => {
        emit({ type: 'disconnected', reason: 'monitor stopped' })
        session = null
        activeContextTokenScope = null
      },
      (err) => {
        if (controller.signal.aborted) return
        emit({ type: 'disconnected', reason: err instanceof Error ? err.message : String(err) })
        session = null
        activeContextTokenScope = null
      },
    )
  } catch (err) {
    activeContextTokenScope = null
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
  const activeSession = session
  try {
    const result = await sendTextWithPersistedFallback(
      () => activeSession.bot.sendMessage(text),
      () => {
        log(`[weixin] native send failed; using persisted token for ${channelId}`)
        return sendTextWithPersistedContextToken(activeSession, channelId, text)
      },
    )
    emit({
      type: 'send_result',
      id,
      ok: true,
      messageId: result.usedFallback ? result.messageId : id,
    })
  } catch (err) {
    emit({ type: 'send_result', id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

const MESSAGE_TYPE_BOT = 2
const MESSAGE_ITEM_TYPE_TEXT = 1
const MESSAGE_STATE_FINISH = 2

function markdownToPlainText(text: string): string {
  return text
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => code.trim())
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\|[\s:|-]+\|$/gm, '')
    .replace(/^\|(.+)\|$/gm, (_, inner: string) =>
      inner.split('|').map((cell) => cell.trim()).join('  '))
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`(.+?)`/g, '$1')
}

async function sendTextWithPersistedContextToken(
  activeSession: SessionState,
  channelId: string,
  text: string,
): Promise<string> {
  const contextToken = loadContextToken(activeSession.stateDir, activeSession.accountId, channelId)
  if (!contextToken) {
    throw new Error('没有找到 context_token，需要在 start() 运行期间至少收到过一条消息')
  }
  const messageId = `openclaw-weixin:${Date.now()}-${randomUUID().replace(/-/g, '').slice(0, 8)}`
  const raw = await postWeixinSendMessage(
    activeSession.baseUrl,
    activeSession.token,
    30_000,
    {
      msg: {
        from_user_id: '',
        to_user_id: channelId,
        client_id: messageId,
        message_type: MESSAGE_TYPE_BOT,
        message_state: MESSAGE_STATE_FINISH,
        item_list: text
          ? [{ type: MESSAGE_ITEM_TYPE_TEXT, text_item: { text: markdownToPlainText(text) } }]
          : undefined,
        context_token: contextToken,
      },
    },
  )
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as { ret?: number; errcode?: number; errmsg?: string }
      const code = parsed.ret ?? parsed.errcode
      if (code !== undefined && code !== 0) {
        throw new Error(`sendMessage ret=${parsed.ret ?? '(none)'} errcode=${parsed.errcode ?? '(none)'} errmsg=${parsed.errmsg ?? '(none)'}`)
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('sendMessage ret=')) throw err
    }
  }
  log(`[weixin] persisted context token send accepted messageId=${messageId}`)
  return messageId
}

async function postWeixinSendMessage(
  baseUrl: string,
  token: string | undefined,
  timeoutMs: number,
  body: unknown,
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const url = new URL('ilink/bot/sendmessage', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: buildHeaders(token),
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const raw = await res.text()
    if (!res.ok) throw new Error(`${res.status}: ${raw}`)
    return raw
  } finally {
    clearTimeout(timer)
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
    const data = Buffer.from(dataBase64, 'base64')
    writeFileSync(filePath, data)
    await session.bot.sendMessage({
      text: caption,
      media: {
        type: inferOutgoingMediaType(filename, data),
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

function inferOutgoingMediaType(filename: string, data: Buffer): OutgoingMediaType {
  const ext = path.extname(filename).toLowerCase()
  if (IMAGE_EXTENSIONS.has(ext) || hasImageMagic(data)) return 'image'
  if (VIDEO_EXTENSIONS.has(ext) || hasVideoMagic(data)) return 'video'
  return 'file'
}

const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.bmp',
])

const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.m4v',
  '.webm',
  '.mkv',
  '.avi',
])

function hasImageMagic(data: Buffer): boolean {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return true
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) return true
  if (data.length >= 6 && (data.subarray(0, 6).toString('ascii') === 'GIF87a' || data.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    return true
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return true
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) return true
  return false
}

function hasVideoMagic(data: Buffer): boolean {
  if (data.length >= 12 && data.subarray(4, 8).toString('ascii') === 'ftyp') return true
  if (data.length >= 4 && data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) return true
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'AVI '
  ) return true
  return false
}

async function shutdown(): Promise<void> {
  if (session) {
    await notifyConnection('stop', { token: session.token, baseUrl: session.baseUrl })
    session.abortController.abort()
    session = null
  }
  activeContextTokenScope = null
  process.exit(0)
}

function handleSubmitVerifyCode(code: string): void {
  const normalized = code.trim()
  if (!normalized) {
    emit({ type: 'error', message: 'Verification code cannot be empty' })
    return
  }
  if (!pendingVerifyCode) {
    emit({ type: 'error', message: 'No Weixin verification code is currently expected' })
    return
  }
  pendingVerifyCode(normalized)
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
    case 'submit_verify_code':
      handleSubmitVerifyCode(cmd.code)
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
