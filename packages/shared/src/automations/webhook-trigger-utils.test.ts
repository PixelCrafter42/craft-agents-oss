import { describe, expect, it } from 'bun:test';
import { validateAutomationsConfig } from './validation.ts';
import {
  getPathValue,
  normalizeWebhookPayload,
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
