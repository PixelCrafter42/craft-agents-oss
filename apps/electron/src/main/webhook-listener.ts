import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { URL } from 'url'
import type { ISessionManager } from '@craft-agent/server-core/handlers'
import {
  normalizeWebhookPayload,
  resolveAutomationsConfigPath,
  validateAutomationsConfig,
  type AutomationsConfig,
  type WebhookTriggerAuth,
  type WebhookTriggerConfig,
} from '@craft-agent/shared/automations'
import {
  getWorkspaceByNameOrId,
  type DesktopWebhookDeliveryRecord,
  type DesktopWebhookListenerConfig,
  type DesktopWebhookListenerStatus,
  type DesktopWebhookLocalTestResult,
} from '@craft-agent/shared/config'
import type { CredentialManager } from '@craft-agent/shared/credentials'

const DEFAULT_AUTH: WebhookTriggerAuth = { type: 'bearer' }
const NOTION_SIGNATURE_HEADER = 'x-notion-signature'
const NOTION_SIGNATURE_PREFIX = 'sha256='
const NOTION_ENROLLMENT_QUERY_PARAM = 'craft_enrollment'
const NOTION_ENROLLMENT_TTL_MS = 10 * 60_000
const MAX_BODY_BYTES = 1024 * 1024
const DELIVERY_LIMIT = 100

type ListenerLogger = Pick<Console, 'info' | 'warn' | 'error'>

interface TriggerLookupResult {
  workspaceId: string
  triggerId: string
  config: AutomationsConfig
  trigger: WebhookTriggerConfig
}

interface AuthResult {
  ok: boolean
  auth: DesktopWebhookDeliveryRecord['auth']
  statusCode?: number
  error?: string
  redactedHeaders?: string[]
  redactedQueryNames?: string[]
}

export class DesktopWebhookListener {
  private server: Server | null = null
  private config: DesktopWebhookListenerConfig | null = null
  private startedAt: number | undefined
  private lastError: string | undefined
  private deliveries: DesktopWebhookDeliveryRecord[] = []
  private readonly notionEnrollmentTails = new Map<string, Promise<void>>()
  private readonly pendingNotionEnrollments = new Map<string, { nonce: string; expiresAt: number }>()

  constructor(
    private readonly sessionManager: ISessionManager,
    private readonly credentialManager: CredentialManager,
    private readonly logger: ListenerLogger = console,
  ) {}

  async start(config: DesktopWebhookListenerConfig): Promise<void> {
    this.config = config
    this.lastError = undefined

    if (!config.enabled) {
      await this.stop()
      return
    }

    if (this.server) {
      await this.stop()
    }

    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handleRequest(req, res).catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          this.logger.error('[desktop-webhook] request failed:', error)
          this.writeJson(res, 500, { ok: false, error: message })
        })
      })

      server.once('error', (error: NodeJS.ErrnoException) => {
        const message = error.code === 'EADDRINUSE'
          ? `Port ${config.port} is already in use`
          : error.message
        this.lastError = message
        reject(new Error(message))
      })

      server.listen(config.port, config.host, () => {
        this.server = server
        this.startedAt = Date.now()
        this.logger.info(`[desktop-webhook] listening on http://${config.host}:${config.port}`)
        resolve()
      })
    })
  }

  async restart(config: DesktopWebhookListenerConfig): Promise<void> {
    await this.stop()
    await this.start(config)
  }

  async stop(): Promise<void> {
    this.pendingNotionEnrollments.clear()
    if (!this.server) return

    const server = this.server
    this.server = null
    this.startedAt = undefined

    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }

  getStatus(): DesktopWebhookListenerStatus {
    const config = this.config ?? { enabled: false, host: '127.0.0.1', port: 9797 }
    return {
      running: !!this.server,
      enabled: config.enabled,
      host: config.host,
      port: config.port,
      url: this.getLocalBaseUrl(config),
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    }
  }

  getRecentDeliveries(workspaceId?: string, triggerId?: string): DesktopWebhookDeliveryRecord[] {
    return this.deliveries
      .filter((record) => !workspaceId || record.workspaceId === workspaceId)
      .filter((record) => !triggerId || record.triggerId === triggerId)
      .slice()
  }

  async checkLocalHealth(): Promise<{ ok: boolean; statusCode?: number; response?: unknown; error?: string }> {
    const status = this.getStatus()
    if (!status.running) {
      return { ok: false, error: status.lastError ?? 'Desktop webhook listener is not running' }
    }

    try {
      const response = await fetch(`${status.url}/health`)
      const body = await this.readFetchJson(response)
      return { ok: response.ok, statusCode: response.status, response: body }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async sendLocalTest(workspaceId: string, triggerId: string): Promise<DesktopWebhookLocalTestResult> {
    const status = this.getStatus()
    if (!status.running) {
      return { ok: false, endpoint: '', error: status.lastError ?? 'Desktop webhook listener is not running' }
    }

    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      return { ok: false, endpoint: '', error: `Workspace not found: ${workspaceId}` }
    }

    const endpointUrl = new URL(`${status.url}/webhooks/${encodeURIComponent(workspace.id)}/${encodeURIComponent(triggerId)}`)
    endpointUrl.searchParams.set('dryRun', '1')
    endpointUrl.searchParams.set('test', '1')

    let lookup: TriggerLookupResult | null = null
    try {
      lookup = this.loadTrigger(workspace.id, triggerId)
    } catch (error) {
      if (!isMissingLocalTestConfigError(error)) {
        return {
          ok: false,
          endpoint: endpointUrl.toString(),
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

    const testBody = {
      source: 'generic',
      eventType: 'test.event',
      deliveryId: `local-test-${Date.now()}`,
      entity: { id: 'local-test', type: 'test' },
      title: 'Local webhook test',
      url: 'http://127.0.0.1/local-test',
    }
    const body = JSON.stringify(testBody)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-craft-local-test': '1',
    }

    if (!lookup) {
      const normalizedEvent = normalizeWebhookPayload({
        workspaceId: workspace.id,
        triggerId,
        config: { source: 'generic', eventType: 'test.event', auth: { type: 'none' } },
        body: testBody,
        headers,
        query: { dryRun: '1', test: '1' },
        rawBodySha256: createHash('sha256').update(body).digest('hex'),
        verified: true,
        dryRun: true,
        test: true,
        deliveryId: testBody.deliveryId,
      })

      const receiveResult = await this.sessionManager.receiveAutomationWebhook({
        workspaceId: workspace.id,
        triggerId,
        mode: 'dry-run',
        payload: normalizedEvent,
        allowMissingTrigger: true,
      })

      const statusCode = receiveResult.ok ? 200 : 400
      this.recordDelivery({
        id: randomUUID(),
        ts: Date.now(),
        method: 'POST',
        path: endpointUrl.pathname,
        workspaceId: workspace.id,
        triggerId,
        statusCode,
        ok: receiveResult.ok,
        dryRun: true,
        auth: 'none',
        matcherValue: receiveResult.matcherValue,
        matchedCount: receiveResult.matchedAutomations.length,
        normalizedEvent,
        error: receiveResult.error,
      })

      return {
        ok: receiveResult.ok,
        endpoint: endpointUrl.toString(),
        statusCode,
        response: {
          ...receiveResult,
          syntheticTrigger: true,
          note: 'Local test used a synthetic trigger because this trigger id is not configured yet.',
        },
      }
    }

    const auth = this.resolveTriggerAuth(lookup.trigger)
    const secret = auth.type === 'none'
      ? null
      : auth.type === 'notion-signature'
        ? await this.getTriggerSecret(lookup.workspaceId, triggerId)
        : await this.ensureTriggerSecret(lookup.workspaceId, triggerId)
    if (auth.type === 'notion-signature' && !secret) {
      const enrollment = this.armNotionEnrollment(lookup.workspaceId, triggerId)
      const enrollmentUrl = new URL(endpointUrl)
      enrollmentUrl.searchParams.delete('dryRun')
      enrollmentUrl.searchParams.delete('test')
      enrollmentUrl.searchParams.set(NOTION_ENROLLMENT_QUERY_PARAM, enrollment.nonce)
      return {
        ok: false,
        endpoint: enrollmentUrl.toString(),
        response: {
          enrollmentPending: true,
          expiresAt: enrollment.expiresAt,
        },
        error: 'Use this one-time endpoint in Notion within 10 minutes to complete webhook verification',
      }
    }
    this.applyClientAuth(auth, secret, body, endpointUrl, headers)
    const reportedEndpointUrl = new URL(endpointUrl)
    if (auth.type === 'query') {
      reportedEndpointUrl.searchParams.delete(auth.queryParam ?? 'token')
    }

    try {
      const response = await fetch(endpointUrl.toString(), {
        method: 'POST',
        headers,
        body,
      })
      const payload = await this.readFetchJson(response)
      return {
        ok: response.ok && !(payload && typeof payload === 'object' && 'ok' in payload && payload.ok === false),
        endpoint: reportedEndpointUrl.toString(),
        statusCode: response.status,
        response: payload,
      }
    } catch (error) {
      return {
        ok: false,
        endpoint: reportedEndpointUrl.toString(),
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async getTriggerSecret(workspaceId: string, triggerId: string): Promise<string | null> {
    const credential = await this.credentialManager.get({ type: 'webhook_secret', workspaceId, name: triggerId })
    return credential?.value ?? null
  }

  async rotateTriggerSecret(workspaceId: string, triggerId: string): Promise<string> {
    const secret = randomBytes(32).toString('base64url')
    await this.credentialManager.set({ type: 'webhook_secret', workspaceId, name: triggerId }, { value: secret })
    return secret
  }

  private async ensureTriggerSecret(workspaceId: string, triggerId: string): Promise<string> {
    const existing = await this.getTriggerSecret(workspaceId, triggerId)
    if (existing) return existing
    return this.rotateTriggerSecret(workspaceId, triggerId)
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'OPTIONS') {
      this.writeJson(res, 204, {})
      return
    }

    const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)

    if (req.method === 'GET' && requestUrl.pathname === '/health') {
      this.writeJson(res, 200, {
        ok: true,
        service: 'craft-desktop-webhooks',
        startedAt: this.startedAt,
        host: this.config?.host,
        port: this.config?.port,
      })
      return
    }

    const match = requestUrl.pathname.match(/^\/webhooks\/([^/]+)\/([^/]+)$/)
    if (req.method !== 'POST' || !match) {
      this.writeJson(res, 404, { ok: false, error: 'Not found' })
      return
    }

    const workspaceId = decodeURIComponent(match[1]!)
    const triggerId = decodeURIComponent(match[2]!)
    const dryRun = isTruthyParam(requestUrl.searchParams.get('dryRun'))
    const test = isTruthyParam(requestUrl.searchParams.get('test')) || req.headers['x-craft-local-test'] === '1'
    const path = requestUrl.pathname

    let lookup: TriggerLookupResult
    try {
      lookup = this.loadTrigger(workspaceId, triggerId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.recordDelivery({
        id: randomUUID(),
        ts: Date.now(),
        method: req.method ?? 'POST',
        path,
        workspaceId,
        triggerId,
        statusCode: 404,
        ok: false,
        dryRun,
        auth: 'failed',
        error: message,
      })
      this.writeJson(res, 404, { ok: false, error: message })
      return
    }

    if (lookup.trigger.enabled === false) {
      const message = `Webhook trigger disabled: ${triggerId}`
      this.recordDelivery({
        id: randomUUID(),
        ts: Date.now(),
        method: req.method ?? 'POST',
        path,
        workspaceId: lookup.workspaceId,
        triggerId,
        statusCode: 403,
        ok: false,
        dryRun,
        auth: 'failed',
        error: message,
      })
      this.writeJson(res, 403, { ok: false, error: message })
      return
    }

    const rawBody = await readRequestBody(req, MAX_BODY_BYTES)
    const body = parseRequestBody(rawBody, req.headers['content-type'])
    const verificationToken = extractVerificationToken(body)
    const triggerAuth = this.resolveTriggerAuth(lookup.trigger)

    // Notion's verification_token is a one-time secret enrollment message,
    // never a webhook event. Serialize enrollment per trigger so concurrent
    // requests cannot both observe an empty credential and overwrite it.
    if (verificationToken && triggerAuth.type === 'notion-signature') {
      const enrollment = await this.enrollNotionVerificationToken(
        lookup,
        verificationToken,
        requestUrl.searchParams.get(NOTION_ENROLLMENT_QUERY_PARAM),
        !dryRun && !test,
      )
      const statusCode = enrollment.statusCode ?? (enrollment.ok ? 200 : 401)
      this.recordDelivery({
        id: randomUUID(),
        ts: Date.now(),
        method: req.method ?? 'POST',
        path,
        workspaceId: lookup.workspaceId,
        triggerId,
        statusCode,
        ok: enrollment.ok,
        dryRun,
        auth: enrollment.auth,
        error: enrollment.error,
      })
      this.writeJson(
        res,
        statusCode,
        enrollment.ok
          ? { ok: true, enrolled: true }
          : { ok: false, error: enrollment.error ?? 'Notion verification token enrollment failed' },
      )
      return
    }

    const authResult = await this.verifyAuth(lookup, req.headers, requestUrl, rawBody)
    if (!authResult.ok) {
      this.recordDelivery({
        id: randomUUID(),
        ts: Date.now(),
        method: req.method ?? 'POST',
        path,
        workspaceId: lookup.workspaceId,
        triggerId,
        statusCode: authResult.statusCode ?? 401,
        ok: false,
        dryRun,
        auth: authResult.auth,
        error: authResult.error,
      })
      this.writeJson(res, authResult.statusCode ?? 401, { ok: false, error: authResult.error ?? 'Unauthorized' })
      return
    }

    const query = queryToRecord(requestUrl)
    const rawBodySha256 = createHash('sha256').update(rawBody).digest('hex')
    const effectiveTrigger = this.getEffectiveTriggerForTest(lookup.trigger, test)

    const normalizedEvent = normalizeWebhookPayload({
      workspaceId: lookup.workspaceId,
      triggerId,
      config: effectiveTrigger,
      body,
      headers: req.headers,
      query,
      rawBodySha256,
      verified: authResult.auth !== 'failed',
      dryRun,
      test,
      deliveryId: req.headers['x-craft-delivery-id'] as string | undefined,
      redactHeaderNames: authResult.redactedHeaders,
      redactQueryNames: authResult.redactedQueryNames,
    })

    const receiveResult = await this.sessionManager.receiveAutomationWebhook({
      workspaceId: lookup.workspaceId,
      triggerId,
      mode: dryRun ? 'dry-run' : 'live',
      payload: normalizedEvent,
    })

    const statusCode = receiveResult.ok ? 200 : 400
    this.recordDelivery({
      id: randomUUID(),
      ts: Date.now(),
      method: req.method ?? 'POST',
      path,
      workspaceId: lookup.workspaceId,
      triggerId,
      statusCode,
      ok: receiveResult.ok,
      dryRun,
      auth: authResult.auth,
      matcherValue: receiveResult.matcherValue,
      matchedCount: receiveResult.matchedAutomations.length,
      normalizedEvent,
      error: receiveResult.error,
    })

    this.writeJson(res, statusCode, receiveResult)
  }

  private loadTrigger(workspaceIdOrName: string, triggerId: string): TriggerLookupResult {
    const workspace = getWorkspaceByNameOrId(workspaceIdOrName)
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceIdOrName}`)
    }

    const configPath = resolveAutomationsConfigPath(workspace.rootPath)
    if (!existsSync(configPath)) {
      throw new Error(`automations.json not found for workspace: ${workspace.id}`)
    }

    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    const validation = validateAutomationsConfig(raw)
    if (!validation.valid || !validation.config) {
      throw new Error(`Invalid automations.json: ${validation.errors.join('; ')}`)
    }

    const trigger = validation.config.webhookTriggers?.[triggerId]
    if (!trigger) {
      throw new Error(`Webhook trigger not found: ${triggerId}`)
    }

    return {
      workspaceId: workspace.id,
      triggerId,
      config: validation.config,
      trigger,
    }
  }

  private async verifyAuth(
    lookup: TriggerLookupResult,
    headers: IncomingHttpHeaders,
    requestUrl: URL,
    rawBody: Buffer,
  ): Promise<AuthResult> {
    const auth = this.resolveTriggerAuth(lookup.trigger)
    if (auth.type === 'none') {
      return { ok: true, auth: 'none' }
    }

    const headerValue = (name: string) => {
      const value = headers[name.toLowerCase()]
      return Array.isArray(value) ? value.join(', ') : value
    }

    switch (auth.type) {
      case 'bearer': {
        const secret = await this.requireTriggerSecret(lookup.workspaceId, lookup.triggerId)
        if (!secret.ok) return secret.result
        const authorization = headerValue('authorization') ?? ''
        const token = authorization.toLowerCase().startsWith('bearer ')
          ? authorization.slice(7).trim()
          : ''
        return compareSecret(token, secret.value)
          ? { ok: true, auth: 'passed', redactedHeaders: ['authorization'] }
          : { ok: false, auth: 'failed', statusCode: 401, error: 'Invalid bearer token' }
      }
      case 'header': {
        const secret = await this.requireTriggerSecret(lookup.workspaceId, lookup.triggerId)
        if (!secret.ok) return secret.result
        const value = headerValue(auth.headerName) ?? ''
        return compareSecret(value, secret.value)
          ? { ok: true, auth: 'passed', redactedHeaders: [auth.headerName] }
          : { ok: false, auth: 'failed', statusCode: 401, error: `Invalid ${auth.headerName} header` }
      }
      case 'query': {
        const secret = await this.requireTriggerSecret(lookup.workspaceId, lookup.triggerId)
        if (!secret.ok) return secret.result
        const param = auth.queryParam ?? 'token'
        const value = requestUrl.searchParams.get(param) ?? ''
        return compareSecret(value, secret.value)
          ? { ok: true, auth: 'passed', redactedQueryNames: [param] }
          : { ok: false, auth: 'failed', statusCode: 401, error: `Invalid ${param} query token` }
      }
      case 'hmac': {
        const secret = await this.requireTriggerSecret(lookup.workspaceId, lookup.triggerId)
        if (!secret.ok) return secret.result
        const algorithm = auth.algorithm ?? 'sha256'
        const prefix = auth.prefix ?? `${algorithm}=`
        const signature = headerValue(auth.headerName) ?? ''
        const digest = createHmac(algorithm, secret.value).update(rawBody).digest('hex')
        const expected = `${prefix}${digest}`
        return compareSecret(signature, expected) || compareSecret(signature, digest)
          ? { ok: true, auth: 'passed', redactedHeaders: [auth.headerName] }
          : { ok: false, auth: 'failed', statusCode: 401, error: `Invalid ${auth.headerName} signature` }
      }
      case 'notion-signature': {
        const secret = await this.requireTriggerSecret(
          lookup.workspaceId,
          lookup.triggerId,
          'Notion verification token is not configured',
        )
        if (!secret.ok) return secret.result
        const signature = headerValue(NOTION_SIGNATURE_HEADER) ?? ''
        const digest = createHmac('sha256', secret.value).update(rawBody).digest('hex')
        const expected = `${NOTION_SIGNATURE_PREFIX}${digest}`
        return compareSecret(signature, expected) || compareSecret(signature, digest)
          ? {
              ok: true,
              auth: 'passed',
              redactedHeaders: [NOTION_SIGNATURE_HEADER],
              redactedQueryNames: [NOTION_ENROLLMENT_QUERY_PARAM],
            }
          : { ok: false, auth: 'failed', statusCode: 401, error: `Invalid ${NOTION_SIGNATURE_HEADER} signature` }
      }
      default:
        return { ok: false, auth: 'failed', statusCode: 400, error: 'Unsupported webhook auth mode' }
    }
  }

  private async enrollNotionVerificationToken(
    lookup: TriggerLookupResult,
    verificationToken: string,
    enrollmentNonce: string | null,
    allowed: boolean,
  ): Promise<AuthResult> {
    if (!allowed) {
      return {
        ok: false,
        auth: 'failed',
        statusCode: 400,
        error: 'Notion verification token enrollment is not available for test or dry-run requests',
      }
    }

    const lockKey = `${lookup.workspaceId}\0${lookup.triggerId}`
    return this.withNotionEnrollmentLock(lockKey, async () => {
      const pending = this.pendingNotionEnrollments.get(lockKey)
      if (!pending || pending.expiresAt <= Date.now()) {
        this.pendingNotionEnrollments.delete(lockKey)
        return {
          ok: false,
          auth: 'failed',
          statusCode: 401,
          error: 'Notion verification enrollment is not armed or has expired',
        }
      }
      if (!enrollmentNonce || !compareSecret(enrollmentNonce, pending.nonce)) {
        return {
          ok: false,
          auth: 'failed',
          statusCode: 401,
          error: 'Invalid Notion verification enrollment nonce',
        }
      }

      const existing = await this.getTriggerSecret(lookup.workspaceId, lookup.triggerId)
      if (existing) {
        this.pendingNotionEnrollments.delete(lockKey)
        return {
          ok: false,
          auth: 'failed',
          statusCode: 409,
          error: 'Notion verification token is already configured',
        }
      }

      await this.credentialManager.set(
        { type: 'webhook_secret', workspaceId: lookup.workspaceId, name: lookup.triggerId },
        { value: verificationToken },
      )
      this.pendingNotionEnrollments.delete(lockKey)
      return { ok: true, auth: 'passed' }
    })
  }

  private armNotionEnrollment(workspaceId: string, triggerId: string): { nonce: string; expiresAt: number } {
    const enrollment = {
      nonce: randomBytes(32).toString('base64url'),
      expiresAt: Date.now() + NOTION_ENROLLMENT_TTL_MS,
    }
    this.pendingNotionEnrollments.set(`${workspaceId}\0${triggerId}`, enrollment)
    return enrollment
  }

  private async withNotionEnrollmentLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.notionEnrollmentTails.get(key) ?? Promise.resolve()
    let release!: () => void
    const lock = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => lock, () => lock)
    this.notionEnrollmentTails.set(key, tail)

    await previous.catch(() => {})
    try {
      return await operation()
    } finally {
      release()
      if (this.notionEnrollmentTails.get(key) === tail) {
        this.notionEnrollmentTails.delete(key)
      }
    }
  }

  private async requireTriggerSecret(
    workspaceId: string,
    triggerId: string,
    error = 'Webhook secret is not configured',
  ): Promise<{ ok: true; value: string } | { ok: false; result: AuthResult }> {
    const secret = await this.getTriggerSecret(workspaceId, triggerId)
    if (secret) return { ok: true, value: secret }
    return { ok: false, result: { ok: false, auth: 'failed', statusCode: 401, error } }
  }

  private resolveTriggerAuth(trigger: WebhookTriggerConfig): WebhookTriggerAuth {
    if (trigger.auth) return trigger.auth
    return trigger.source?.toLowerCase() === 'notion'
      ? { type: 'notion-signature' }
      : DEFAULT_AUTH
  }

  private applyClientAuth(
    auth: WebhookTriggerAuth,
    secret: string | null,
    rawBody: string,
    url: URL,
    headers: Record<string, string>,
  ): void {
    if (!secret) return

    switch (auth.type) {
      case 'bearer':
        headers.authorization = `Bearer ${secret}`
        break
      case 'header':
        headers[auth.headerName] = secret
        break
      case 'query':
        url.searchParams.set(auth.queryParam ?? 'token', secret)
        break
      case 'hmac': {
        const algorithm = auth.algorithm ?? 'sha256'
        const prefix = auth.prefix ?? `${algorithm}=`
        const digest = createHmac(algorithm, secret).update(rawBody).digest('hex')
        headers[auth.headerName] = `${prefix}${digest}`
        break
      }
      case 'notion-signature': {
        const digest = createHmac('sha256', secret).update(rawBody).digest('hex')
        headers[NOTION_SIGNATURE_HEADER] = `${NOTION_SIGNATURE_PREFIX}${digest}`
        break
      }
      case 'none':
        break
    }
  }

  private getEffectiveTriggerForTest(trigger: WebhookTriggerConfig, test: boolean): WebhookTriggerConfig {
    if (!test) return trigger
    const mapping = trigger.mapping ?? {}
    return {
      ...trigger,
      source: trigger.source ?? (mapping.source ? undefined : 'generic'),
      eventType: trigger.eventType ?? (mapping.eventType ? undefined : 'test.event'),
    }
  }

  private recordDelivery(record: DesktopWebhookDeliveryRecord): void {
    this.deliveries.unshift(record)
    if (this.deliveries.length > DELIVERY_LIMIT) {
      this.deliveries.length = DELIVERY_LIMIT
    }
  }

  private getLocalBaseUrl(config: Pick<DesktopWebhookListenerConfig, 'host' | 'port'>): string {
    const host = config.host.includes(':') && !config.host.startsWith('[')
      ? `[${config.host}]`
      : config.host
    return `http://${host}:${config.port}`
  }

  private writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
    res.statusCode = statusCode
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
    res.setHeader('access-control-allow-headers', 'content-type, authorization, x-craft-local-test')
    if (statusCode === 204) {
      res.end()
    } else {
      res.end(JSON.stringify(body))
    }
  }

  private async readFetchJson(response: Response): Promise<unknown> {
    const text = await response.text()
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
}

function isTruthyParam(value: string | null): boolean {
  return value === '1' || value === 'true' || value === 'yes'
}

function isMissingLocalTestConfigError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.startsWith('Webhook trigger not found:')
    || message.startsWith('automations.json not found for workspace:')
}

function queryToRecord(url: URL): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {}
  for (const [key, value] of url.searchParams.entries()) {
    const existing = result[key]
    if (existing === undefined) {
      result[key] = value
    } else if (Array.isArray(existing)) {
      existing.push(value)
    } else {
      result[key] = [existing, value]
    }
  }
  return result
}

function parseRequestBody(rawBody: Buffer, contentType: string | string[] | undefined): unknown {
  if (rawBody.length === 0) return {}
  const normalizedContentType = Array.isArray(contentType) ? contentType.join(',') : (contentType ?? '')
  const text = rawBody.toString('utf-8')
  if (normalizedContentType.toLowerCase().includes('json')) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return text
}

function extractVerificationToken(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const token = (body as Record<string, unknown>).verification_token
  return typeof token === 'string' && token.length > 0 ? token : undefined
}

async function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maxBytes) {
      throw new Error(`Request body too large: max ${maxBytes} bytes`)
    }
    chunks.push(buffer)
  }

  return Buffer.concat(chunks)
}

function compareSecret(actual: string, expected: string): boolean {
  if (!actual || !expected) return false
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
}
