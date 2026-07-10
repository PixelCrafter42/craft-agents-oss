import type { WebhookReceivedPayload } from './event-bus.ts';
import type { WebhookMappingRule, WebhookTriggerConfig } from './types.ts';

const DEFAULT_SOURCE = 'generic';
const DEFAULT_EVENT_TYPE = 'request.received';

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-webhook-secret',
  'x-hub-signature',
  'x-hub-signature-256',
  'stripe-signature',
  'notion-signature',
  'x-notion-signature',
]);

const RESERVED_PAYLOAD_FIELDS = new Set([
  'workspaceId',
  'timestamp',
  'triggerId',
  'source',
  'eventType',
  'matcherValue',
  'deliveryId',
  'entityId',
  'entityType',
  'title',
  'url',
  'actor',
  'occurredAt',
  'verified',
  'dryRun',
  'test',
  'headers',
  'query',
  'body',
  'rawBodySha256',
  'mapped',
]);

export interface NormalizeWebhookPayloadInput {
  workspaceId: string;
  triggerId: string;
  config?: WebhookTriggerConfig;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
  rawBodySha256?: string;
  verified: boolean;
  dryRun?: boolean;
  test?: boolean;
  deliveryId?: string;
  timestamp?: number;
  redactHeaderNames?: string[];
  redactQueryNames?: string[];
}

export function normalizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    normalized[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return normalized;
}

export function normalizeQuery(query: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
  const normalized: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    normalized[key] = Array.isArray(value) ? value.map(String) : String(value);
  }
  return normalized;
}

export function redactQuery(
  query: Record<string, string | string[] | undefined>,
  secretQueryNames: string[] = [],
): Record<string, string | string[]> {
  const normalized = normalizeQuery(query);
  for (const name of secretQueryNames) {
    delete normalized[name];
  }
  return normalized;
}

export function redactHeaders(
  headers: Record<string, string | string[] | undefined>,
  extraSecretHeaders: string[] = [],
): Record<string, string> {
  const normalized = normalizeHeaders(headers);
  const sensitive = new Set(SENSITIVE_HEADER_NAMES);
  for (const header of extraSecretHeaders) {
    sensitive.add(header.toLowerCase());
  }

  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(normalized)) {
    redacted[key] = sensitive.has(key) ? '[redacted]' : value;
  }
  return redacted;
}

export function getPathValue(source: unknown, path: string | undefined): unknown {
  if (!path) return undefined;

  const parts = path.split('.').filter(Boolean);
  let current: unknown = source;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;

    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0) return undefined;
      current = current[index];
      continue;
    }

    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
      continue;
    }

    return undefined;
  }

  return current;
}

export function resolveMappingRule(
  rule: WebhookMappingRule,
  request: {
    body: unknown;
    headers: Record<string, string>;
    query: Record<string, string | string[]>;
  },
): unknown {
  if (rule.from === 'constant') {
    return rule.value ?? rule.default;
  }

  const source = rule.from === 'body'
    ? request.body
    : rule.from === 'header'
      ? request.headers
      : request.query;

  const paths = [rule.path, ...(rule.paths ?? [])].filter((path): path is string => !!path);
  for (const path of paths) {
    const normalizedPath = rule.from === 'header' ? path.toLowerCase() : path;
    const value = getPathValue(source, normalizedPath);
    if (value !== undefined && value !== null && value !== '') return value;
  }

  return rule.default;
}

export function getWebhookMatcherValue(payload: Pick<WebhookReceivedPayload, 'source' | 'eventType'>): string {
  const source = String(payload.source || DEFAULT_SOURCE).trim() || DEFAULT_SOURCE;
  const eventType = String(payload.eventType || DEFAULT_EVENT_TYPE).trim() || DEFAULT_EVENT_TYPE;
  return `${source}:${eventType}`;
}

export function normalizeWebhookPayload(input: NormalizeWebhookPayloadInput): WebhookReceivedPayload {
  // Authentication headers and query parameters must be sanitized before
  // mapping so secrets cannot be copied into mapped fields, logs, or agent
  // context. Non-sensitive request metadata remains available to mappings.
  const headers = redactHeaders(input.headers, input.redactHeaderNames);
  const query = redactQuery(input.query, input.redactQueryNames);
  const mapping = input.config?.mapping ?? {};
  const request = { body: input.body, headers, query };

  const mapped: Record<string, unknown> = {};
  for (const [field, rule] of Object.entries(mapping)) {
    const value = resolveMappingRule(rule, request);
    if (value !== undefined) mapped[field] = value;
  }

  const source = String(mapped.source ?? input.config?.source ?? DEFAULT_SOURCE);
  const eventType = String(mapped.eventType ?? input.config?.eventType ?? DEFAULT_EVENT_TYPE);
  const matcherValue = getWebhookMatcherValue({ source, eventType });

  const payload: WebhookReceivedPayload = {
    workspaceId: input.workspaceId,
    timestamp: input.timestamp ?? Date.now(),
    triggerId: input.triggerId,
    source,
    eventType,
    matcherValue,
    verified: input.verified,
    headers,
    query,
    body: input.body,
    mapped,
  };

  if (input.rawBodySha256) payload.rawBodySha256 = input.rawBodySha256;
  if (input.deliveryId) payload.deliveryId = input.deliveryId;
  if (input.dryRun) payload.dryRun = true;
  if (input.test) payload.test = true;

  const optionalStringFields = ['deliveryId', 'entityId', 'entityType', 'title', 'url', 'actor', 'occurredAt'] as const;
  for (const field of optionalStringFields) {
    const value = mapped[field];
    if (typeof value === 'string' && value.length > 0) {
      payload[field] = value;
    } else if (value !== undefined && value !== null && value !== '') {
      payload[field] = String(value);
    }
  }

  for (const [field, value] of Object.entries(mapped)) {
    if (!RESERVED_PAYLOAD_FIELDS.has(field)) {
      payload[field] = value;
    }
  }

  return payload;
}
