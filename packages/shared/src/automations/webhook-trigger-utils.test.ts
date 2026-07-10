import { describe, expect, it } from 'bun:test';
import { validateAutomationsConfig } from './validation.ts';
import {
  getPathValue,
  normalizeWebhookPayload,
  redactQuery,
  redactHeaders,
  resolveMappingRule,
} from './webhook-trigger-utils.ts';

describe('webhook trigger utilities', () => {
  it('reads dot paths and array indexes', () => {
    const payload = { data: { items: [{ id: 'first' }, { id: 'second' }] } };
    expect(getPathValue(payload, 'data.items.1.id')).toBe('second');
  });

  it('uses fallback paths when the primary path is missing', () => {
    const value = resolveMappingRule(
      { from: 'body', path: 'missing.id', paths: ['page.id', 'fallback.id'] },
      {
        body: { page: { id: 'page-123' } },
        headers: {},
        query: {},
      },
    );
    expect(value).toBe('page-123');
  });

  it('redacts sensitive headers case-insensitively', () => {
    expect(redactHeaders({
      Authorization: 'Bearer secret',
      'X-Notion-Signature': 'sha256=secret',
      'X-Request-Id': 'req-1',
    })).toEqual({
      authorization: '[redacted]',
      'x-notion-signature': '[redacted]',
      'x-request-id': 'req-1',
    });
  });

  it('removes authentication query parameters before mapping and payload creation', () => {
    expect(redactQuery({ token: 'super-secret', event: 'created' }, ['token'])).toEqual({
      event: 'created',
    });

    const payload = normalizeWebhookPayload({
      workspaceId: 'workspace-1',
      triggerId: 'query-auth',
      config: {
        source: 'generic',
        mapping: {
          eventType: { from: 'query', path: 'event' },
          copiedSecret: { from: 'query', path: 'token', default: 'not-available' },
        },
      },
      body: {},
      headers: {},
      query: { token: 'super-secret', event: 'created' },
      redactQueryNames: ['token'],
      verified: true,
    });

    expect(payload.matcherValue).toBe('generic:created');
    expect(payload.query).toEqual({ event: 'created' });
    expect(payload.mapped.copiedSecret).toBe('not-available');
    expect(JSON.stringify(payload)).not.toContain('super-secret');
  });

  it('redacts authentication headers before mapping while preserving ordinary headers', () => {
    const payload = normalizeWebhookPayload({
      workspaceId: 'workspace-1',
      triggerId: 'header-auth',
      config: {
        source: 'generic',
        mapping: {
          eventType: { from: 'header', path: 'x-event-type' },
          copiedAuthorization: { from: 'header', path: 'authorization' },
          copiedCustomSecret: { from: 'header', path: 'x-custom-secret' },
          requestId: { from: 'header', path: 'x-request-id' },
        },
      },
      body: {},
      headers: {
        Authorization: 'Bearer super-secret',
        'X-Custom-Secret': 'ultra-private-value',
        'X-Event-Type': 'created',
        'X-Request-Id': 'request-1',
      },
      query: {},
      redactHeaderNames: ['x-custom-secret'],
      verified: true,
    });

    expect(payload.matcherValue).toBe('generic:created');
    expect(payload.mapped).toMatchObject({
      copiedAuthorization: '[redacted]',
      copiedCustomSecret: '[redacted]',
      requestId: 'request-1',
    });
    expect(payload.headers['x-request-id']).toBe('request-1');
    expect(JSON.stringify(payload)).not.toContain('super-secret');
    expect(JSON.stringify(payload)).not.toContain('ultra-private-value');
  });

  it('normalizes arbitrary webhook payloads into WebhookReceived payloads', () => {
    const payload = normalizeWebhookPayload({
      workspaceId: 'workspace-1',
      triggerId: 'notion-pages',
      config: {
        source: 'notion',
        mapping: {
          eventType: { from: 'body', path: 'type', default: 'page.created' },
          entityId: { from: 'body', path: 'page.id' },
          actor: { from: 'header', path: 'x-user' },
          workspaceSlug: { from: 'query', path: 'workspace' },
        },
      },
      body: { type: 'database.page.created', page: { id: 'page-123' } },
      headers: { 'X-User': 'alice', Authorization: 'Bearer secret' },
      query: { workspace: 'docs' },
      verified: true,
      dryRun: true,
      rawBodySha256: 'abc',
    });

    expect(payload.source).toBe('notion');
    expect(payload.eventType).toBe('database.page.created');
    expect(payload.matcherValue).toBe('notion:database.page.created');
    expect(payload.entityId).toBe('page-123');
    expect(payload.actor).toBe('alice');
    expect(payload.workspaceSlug).toBe('docs');
    expect(payload.headers.authorization).toBe('[redacted]');
  });

  it('validates and preserves webhookTriggers in automations config', () => {
    const result = validateAutomationsConfig({
      version: 2,
      webhookTriggers: {
        notion_pages: {
          source: 'notion',
          eventType: 'database.page.created',
          auth: { type: 'notion-signature' },
          mapping: {
            entityId: { from: 'body', path: 'page.id' },
          },
        },
      },
      automations: {
        WebhookReceived: [{
          matcher: '^notion:database\\.page\\.created$',
          actions: [{ type: 'prompt', prompt: 'Handle $CRAFT_ENTITY_ID' }],
        }],
      },
    });

    expect(result.valid).toBe(true);
    expect(result.config?.webhookTriggers?.notion_pages?.source).toBe('notion');
    expect(result.config?.automations.WebhookReceived).toHaveLength(1);
  });
});
