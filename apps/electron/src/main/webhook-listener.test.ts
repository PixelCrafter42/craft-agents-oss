import { afterEach, describe, expect, it } from 'bun:test'
import { createHmac } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { WebhookTriggerConfig } from '@craft-agent/shared/automations'
import { DesktopWebhookListener } from './webhook-listener'

const activeListeners: DesktopWebhookListener[] = []

afterEach(async () => {
  await Promise.all(activeListeners.splice(0).map((listener) => listener.stop()))
})

function createHarness(trigger: WebhookTriggerConfig, initialSecret?: string) {
  const secrets = new Map<string, string>()
  if (initialSecret) secrets.set('workspace-1/trigger-1', initialSecret)
  const received: unknown[] = []

  const credentialManager = {
    async get(locator: { workspaceId: string; name: string }) {
      const value = secrets.get(`${locator.workspaceId}/${locator.name}`)
      return value ? { value } : null
    },
    async set(locator: { workspaceId: string; name: string }, credential: { value: string }) {
      secrets.set(`${locator.workspaceId}/${locator.name}`, credential.value)
    },
  }
  const sessionManager = {
    async receiveAutomationWebhook(input: { payload: { matcherValue: string } }) {
      received.push(input)
      return {
        ok: true,
        matcherValue: input.payload.matcherValue,
        matchedAutomations: [],
      }
    },
  }
  const listener = new DesktopWebhookListener(
    sessionManager as never,
    credentialManager as never,
    { info() {}, warn() {}, error() {} },
  )

  ;(listener as unknown as { loadTrigger: () => unknown }).loadTrigger = () => ({
    workspaceId: 'workspace-1',
    triggerId: 'trigger-1',
    config: { version: 2, automations: {}, webhookTriggers: { 'trigger-1': trigger } },
    trigger,
  })
  activeListeners.push(listener)

  return { listener, secrets, received }
}

async function startListener(listener: DesktopWebhookListener): Promise<string> {
  await listener.start({ enabled: true, host: '127.0.0.1', port: 0 })
  const server = (listener as unknown as { server: Server }).server
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}/webhooks/workspace-1/trigger-1`
}

function armNotionEnrollment(listener: DesktopWebhookListener): string {
  const enrollment = (listener as unknown as {
    armNotionEnrollment: (workspaceId: string, triggerId: string) => { nonce: string }
  }).armNotionEnrollment('workspace-1', 'trigger-1')
  return enrollment.nonce
}

describe('DesktopWebhookListener security boundaries', () => {
  it('requires an explicit nonce, then enrolls once without dispatching an event', async () => {
    const { listener, secrets, received } = createHarness({
      source: 'notion',
      auth: { type: 'notion-signature' },
    })
    const endpoint = await startListener(listener)

    const unarmed = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verification_token: 'attacker-secret' }),
    })
    expect(unarmed.status).toBe(401)
    expect(secrets.get('workspace-1/trigger-1')).toBeUndefined()
    expect(received).toHaveLength(0)

    const nonce = armNotionEnrollment(listener)
    const enrollmentEndpoint = `${endpoint}?craft_enrollment=${encodeURIComponent(nonce)}`
    const first = await fetch(enrollmentEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verification_token: 'first-secret' }),
    })
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ ok: true, enrolled: true })
    expect(secrets.get('workspace-1/trigger-1')).toBe('first-secret')
    expect(received).toHaveLength(0)

    const second = await fetch(enrollmentEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verification_token: 'attacker-secret' }),
    })
    expect(second.status).toBe(401)
    expect(secrets.get('workspace-1/trigger-1')).toBe('first-secret')
    expect(received).toHaveLength(0)

    const eventBody = JSON.stringify({ type: 'page.updated' })
    const signature = createHmac('sha256', 'first-secret').update(eventBody).digest('hex')
    const event = await fetch(enrollmentEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-notion-signature': `sha256=${signature}`,
      },
      body: eventBody,
    })
    expect(event.status).toBe(200)
    expect(received).toHaveLength(1)
    expect(JSON.stringify(received[0])).not.toContain(nonce)
    expect(JSON.stringify(listener.getRecentDeliveries())).not.toContain('first-secret')
    expect(JSON.stringify(listener.getRecentDeliveries())).not.toContain('attacker-secret')
    expect(JSON.stringify(listener.getRecentDeliveries())).not.toContain(nonce)
  })

  it('serializes concurrent Notion enrollment so only one token can win', async () => {
    const { listener, secrets, received } = createHarness({
      source: 'notion',
      auth: { type: 'notion-signature' },
    })
    const endpoint = await startListener(listener)
    const nonce = armNotionEnrollment(listener)

    const responses = await Promise.all(['one', 'two'].map((verificationToken) => fetch(
      `${endpoint}?craft_enrollment=${encodeURIComponent(nonce)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verification_token: verificationToken }),
      },
    )))

    expect(responses.map((response) => response.status).sort()).toEqual([200, 401])
    const storedSecret = secrets.get('workspace-1/trigger-1')
    expect(storedSecret).toBeDefined()
    expect(['one', 'two']).toContain(storedSecret!)
    expect(received).toHaveLength(0)
  })

  it('authenticates with a query secret but removes it before mapping and delivery', async () => {
    const { listener, received } = createHarness({
      source: 'generic',
      auth: { type: 'query', queryParam: 'secret' },
      mapping: {
        eventType: { from: 'query', path: 'event' },
        copiedSecret: { from: 'query', path: 'secret', default: 'not-available' },
      },
    }, 'query-secret-value')
    const endpoint = await startListener(listener)

    const response = await fetch(`${endpoint}?secret=query-secret-value&event=created`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })

    expect(response.status).toBe(200)
    expect(received).toHaveLength(1)
    const serializedDelivery = JSON.stringify(received[0])
    expect(serializedDelivery).not.toContain('query-secret-value')
    expect(received[0]).toMatchObject({
      payload: {
        matcherValue: 'generic:created',
        query: { event: 'created' },
        mapped: { eventType: 'created', copiedSecret: 'not-available' },
      },
    })
    expect(JSON.stringify(listener.getRecentDeliveries())).not.toContain('query-secret-value')
  })
})
