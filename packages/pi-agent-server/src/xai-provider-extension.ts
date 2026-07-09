import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { streamSimpleOpenAIResponses } from '@earendil-works/pi-ai/compat';
import type { Api, Context, Model, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { refreshXaiTokens } from '../../shared/src/auth/xai-oauth.ts';

const XAI_PROVIDER_ID = 'xai-auth';
const XAI_API_BASE_URL = 'https://api.x.ai/v1';
const XAI_CLI_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
const XAI_GROK_CLIENT_VERSION = '0.2.16';

const XAI_MODELS = [
  {
    id: 'grok-4.5',
    name: 'Grok 4.5',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 500_000,
    maxTokens: 131_072,
    thinkingLevelMap: {
      off: null,
      minimal: 'low',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: null,
    },
  },
  {
    id: 'grok-4.3',
    name: 'Grok 4.3',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
  },
  {
    id: 'grok-build',
    name: 'Grok Build',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0.2 },
    contextWindow: 512_000,
    maxTokens: 30_000,
  },
  {
    id: 'grok-composer-2.5-fast',
    name: 'Composer 2.5 Fast',
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 3, output: 15, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 30_000,
    thinkingLevelMap: {
      off: 'none',
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
    },
  },
  {
    id: 'grok-4.20-0309-reasoning',
    name: 'Grok 4.20 Reasoning',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 2_000_000,
    maxTokens: 131_072,
  },
  {
    id: 'grok-4.20-0309-non-reasoning',
    name: 'Grok 4.20 Non-Reasoning',
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 2_000_000,
    maxTokens: 131_072,
  },
  {
    id: 'grok-4.20-multi-agent-0309',
    name: 'Grok 4.20 Multi-Agent',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 2_000_000,
    maxTokens: 131_072,
  },
];

function normalizedModelId(modelId: string): string {
  return (modelId || '').toLowerCase().split('/').pop() || '';
}

function isGrokCliProxyModel(modelId: string): boolean {
  const normalized = normalizedModelId(modelId);
  return normalized === 'grok-build' || normalized === 'grok-composer-2.5-fast';
}

function grokSupportsReasoningEffort(modelId: string): boolean {
  const normalized = normalizedModelId(modelId);
  return (
    normalized.startsWith('grok-3-mini') ||
    normalized.startsWith('grok-4.20-multi-agent') ||
    normalized.startsWith('grok-4.3') ||
    normalized.startsWith('grok-4.5')
  );
}

function xaiBaseUrlForModel(modelId: string): string {
  return isGrokCliProxyModel(modelId) ? XAI_CLI_BASE_URL : XAI_API_BASE_URL;
}

function grokCliProxyHeaders(modelId: string, sessionId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'x-grok-client-identifier': 'craft-agents-xai-oauth',
    'x-grok-client-version': XAI_GROK_CLIENT_VERSION,
    'x-xai-token-auth': 'xai-grok-cli',
    'x-grok-model-override': normalizedModelId(modelId),
  };
  if (sessionId) headers['x-grok-conv-id'] = sessionId;
  return headers;
}

function xaiModelRequestHeaders(modelId: string, sessionId?: string): Record<string, string> {
  return isGrokCliProxyModel(modelId) ? grokCliProxyHeaders(modelId, sessionId) : {};
}

function stripShellQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function unescapeShellPath(value: string): string {
  return stripShellQuotes(value).replace(/\\([\\\s'"()&;@])/g, '$1');
}

function imageMimeTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    default:
      throw new Error('xAI image understanding supports local .jpg, .jpeg, .png, and .webp files');
  }
}

function normalizeXaiImageInput(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const cleaned = stripShellQuotes(value);
  if (/^https?:\/\//i.test(cleaned) || /^data:image\//i.test(cleaned)) return cleaned;

  let localPath = unescapeShellPath(cleaned);
  if (localPath.startsWith('file://')) localPath = fileURLToPath(localPath);
  const candidates = [localPath];
  if (!isAbsolute(localPath)) candidates.push(resolve(process.cwd(), localPath));
  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) throw new Error(`Image file does not exist or is not a valid URL: ${cleaned}`);

  const mimeType = imageMimeTypeForPath(found);
  return `data:${mimeType};base64,${readFileSync(found).toString('base64')}`;
}

function textFromResponsesContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      const item = part as { type?: unknown; text?: unknown };
      const type = typeof item.type === 'string' ? item.type : '';
      return ['text', 'input_text', 'output_text'].includes(type) && typeof item.text === 'string' ? item.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function normalizeImageParts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeImageParts);
  if (!value || typeof value !== 'object') return value;

  const obj: Record<string, any> = { ...(value as Record<string, any>) };
  if (obj.type === 'image' && typeof obj.data === 'string' && typeof obj.mimeType === 'string') {
    return {
      type: 'input_image',
      image_url: `data:${obj.mimeType};base64,${obj.data}`,
      detail: typeof obj.detail === 'string' && obj.detail ? obj.detail : 'auto',
    };
  }
  if (obj.type === 'image_url') {
    const imageUrl = typeof obj.image_url === 'object' && obj.image_url ? obj.image_url.url : obj.image_url;
    const detail = typeof obj.image_url === 'object' && obj.image_url ? obj.image_url.detail : obj.detail;
    obj.type = 'input_image';
    obj.image_url = imageUrl;
    if (typeof detail === 'string' && detail) obj.detail = detail;
  }
  if (obj.type === 'input_image') {
    const imageUrl = typeof obj.image_url === 'object' && obj.image_url ? obj.image_url.url : obj.image_url;
    const detail = typeof obj.image_url === 'object' && obj.image_url ? obj.image_url.detail : obj.detail;
    const normalized = normalizeXaiImageInput(imageUrl);
    if (normalized) obj.image_url = normalized;
    if (typeof detail === 'string' && detail) obj.detail = detail;
    if (typeof obj.detail !== 'string' || !obj.detail) obj.detail = 'auto';
  }
  if (Array.isArray(obj.content)) obj.content = normalizeImageParts(obj.content);
  if (Array.isArray(obj.output)) obj.output = normalizeImageParts(obj.output);
  return obj;
}

function isInputImagePart(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && (value as Record<string, any>).type === 'input_image';
}

function textForFunctionCallOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (!Array.isArray(output)) return output === undefined || output === null ? '' : JSON.stringify(output);

  const chunks: string[] = [];
  let imageCount = 0;
  for (const part of output) {
    if (isInputImagePart(part)) {
      imageCount++;
      continue;
    }
    const text = textFromResponsesContent([part]).trim();
    if (text) chunks.push(text);
  }
  if (imageCount > 0) chunks.push(`[${imageCount} image${imageCount === 1 ? '' : 's'} attached in the following user message]`);
  return chunks.join('\n') || (imageCount > 0 ? `[${imageCount} image${imageCount === 1 ? '' : 's'} attached]` : '');
}

function normalizeXaiResponsesInput(input: unknown[], model: Model<Api>): unknown[] {
  const normalized = input.map(normalizeImageParts) as Record<string, any>[];
  const rewritten: unknown[] = [];
  const modelInputs = Array.isArray((model as any).input) ? ((model as any).input as unknown[]) : [];
  const supportsImages = modelInputs.includes('image');

  for (const item of normalized) {
    if (!item || typeof item !== 'object' || item.type !== 'function_call_output' || !Array.isArray(item.output)) {
      rewritten.push(item);
      continue;
    }

    const outputParts = item.output;
    const imageParts = outputParts.filter(isInputImagePart);
    rewritten.push({ ...item, output: textForFunctionCallOutput(outputParts) || '(tool returned no text output)' });

    if (supportsImages && imageParts.length > 0) {
      const label = `The previous tool result${item.call_id ? ` (${item.call_id})` : ''} included ${imageParts.length} image${imageParts.length === 1 ? '' : 's'}. Use the attached image${imageParts.length === 1 ? '' : 's'} as the visual output from that tool.`;
      rewritten.push({
        role: 'user',
        content: [{ type: 'input_text', text: label }, ...imageParts],
      });
    }
  }

  return rewritten;
}

function rewriteXaiResponsesPayload(payload: unknown, model: Model<Api>, options?: SimpleStreamOptions): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const body: Record<string, any> = { ...(payload as Record<string, any>) };
  const modelId = String(body.model || model.id);
  const usesGrokCliProxy = isGrokCliProxyModel(modelId);

  if (Array.isArray(body.input)) {
    let input = normalizeXaiResponsesInput([...body.input], model) as Record<string, any>[];
    const instructionParts: string[] = [];

    if (usesGrokCliProxy) {
      input = input.filter((item) => {
        if (!item || typeof item !== 'object') return true;
        if (item.type === 'reasoning') return false;
        if (typeof item.content === 'string' && item.content.length === 0) return false;
        if (item.role !== 'developer' && item.role !== 'system') return true;
        const text = textFromResponsesContent(item.content).trim();
        if (text) instructionParts.push(text);
        return false;
      });
    } else {
      while (input.length > 0) {
        const first = input[0];
        if (!first || typeof first !== 'object' || (first.role !== 'developer' && first.role !== 'system')) break;
        const text = textFromResponsesContent(first.content).trim();
        if (text) instructionParts.push(text);
        input.shift();
      }
    }

    if (instructionParts.length > 0) {
      body.instructions = [body.instructions, ...instructionParts].filter((part) => typeof part === 'string' && part).join('\n\n');
    }
    body.input = input;
  }

  if (body.response_format && !body.text) {
    body.text = { format: body.response_format };
    delete body.response_format;
  }

  if (body.reasoning && typeof body.reasoning === 'object') {
    const effort = body.reasoning.effort;
    if (typeof effort === 'string' && effort !== 'none' && grokSupportsReasoningEffort(modelId)) {
      body.reasoning = { effort: effort === 'minimal' ? 'low' : effort };
    } else {
      delete body.reasoning;
    }
  }

  if (usesGrokCliProxy && Array.isArray(body.include)) {
    body.include = body.include.filter((item: unknown) => item !== 'reasoning.encrypted_content');
    if (body.include.length === 0) delete body.include;
  }

  delete body.prompt_cache_retention;
  const cacheKey =
    (typeof body.prompt_cache_key === 'string' && body.prompt_cache_key.trim()) ||
    (typeof options?.sessionId === 'string' && options.sessionId.trim()) ||
    '';
  if (cacheKey) body.prompt_cache_key = cacheKey;
  else delete body.prompt_cache_key;

  return body;
}

function streamSimpleXaiResponses(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
  const sessionId = options?.sessionId;
  const routingSessionId = sessionId || (isGrokCliProxyModel(model.id) ? randomUUID() : undefined);
  const streamModel = {
    ...model,
    baseUrl: xaiBaseUrlForModel(model.id),
    headers: {
      ...(model as any).headers,
      ...xaiModelRequestHeaders(model.id, routingSessionId),
    },
  };
  const openAIResponsesModel = {
    ...streamModel,
    api: 'openai-responses' as const,
  };
  const headers = { ...(options?.headers || {}) };
  if (routingSessionId && !headers['x-grok-conv-id']) headers['x-grok-conv-id'] = routingSessionId;

  return streamSimpleOpenAIResponses(openAIResponsesModel as Model<'openai-responses'>, context, {
    ...options,
    sessionId: sessionId || routingSessionId,
    headers,
    async onPayload(payload: unknown) {
      const rewritten = rewriteXaiResponsesPayload(payload, streamModel as Model<Api>, {
        ...options,
        sessionId: sessionId || routingSessionId,
      });
      const userRewritten = await options?.onPayload?.(rewritten, streamModel as Model<Api>);
      return userRewritten === undefined ? rewritten : userRewritten;
    },
  } as SimpleStreamOptions);
}

export default function xaiProviderExtension(pi: ExtensionAPI): void {
  pi.registerProvider(XAI_PROVIDER_ID, {
    name: 'xAI (OAuth)',
    baseUrl: XAI_API_BASE_URL,
    api: 'xai-responses',
    models: XAI_MODELS as any,
    authHeader: true,
    streamSimple: streamSimpleXaiResponses as any,
    oauth: {
      name: 'xAI (OAuth)',
      usesCallbackServer: true,
      async login() {
        throw new Error('Use Craft Agents Settings to connect xAI / Grok.');
      },
      async refreshToken(credentials: { refresh: string; access: string; expires: number }) {
        const tokens = await refreshXaiTokens(credentials.refresh);
        return {
          access: tokens.accessToken,
          refresh: tokens.refreshToken || credentials.refresh,
          expires: tokens.expiresAt ?? credentials.expires,
          ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
        };
      },
      getApiKey(credentials: { access: string }) {
        return credentials.access;
      },
    },
  } as any);
}
