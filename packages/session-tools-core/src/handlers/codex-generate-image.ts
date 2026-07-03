/**
 * Codex Image Generation Handler
 *
 * Uses the ChatGPT/Codex backend Responses endpoint with the native
 * image_generation tool, authenticated by the user's stored openai-codex
 * OAuth token.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, parse } from 'node:path';
import type {
  LlmOAuthCredential,
  LlmConnectionInfo,
  SessionToolContext,
} from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export type CodexImageOutputFormat = 'png' | 'jpeg' | 'webp';

export interface CodexGenerateImageArgs {
  prompt: string;
  model?: string;
  outputFormat?: CodexImageOutputFormat;
  connectionSlug?: string;
  fileName?: string;
}

interface GeneratedImage {
  id: string;
  status: string;
  result: string;
  revisedPrompt?: string;
}

interface ParsedCodexResponse {
  image?: GeneratedImage;
  text: string[];
  responseId?: string;
  usage?: unknown;
}

type CodexSseEvent =
  | { type: 'error'; message?: string; code?: string }
  | { type: 'response.failed'; response?: { error?: { message?: string } } }
  | { type: 'response.created'; response?: { id?: string } }
  | { type: 'response.output_text.delta'; delta?: string }
  | {
      type: 'response.output_item.done';
      item?: {
        type?: string;
        id?: string | number;
        status?: string;
        result?: string;
        revised_prompt?: string;
      };
    }
  | { type: 'response.completed'; response?: { id?: string; usage?: unknown } };

const PROVIDER = 'openai-codex';
const DEFAULT_MODEL = 'gpt-5.5';
const BACKEND_IMAGE_MODEL = 'gpt-image-2';
const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';
const OPENAI_BETA_HEADER = 'responses=experimental';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5 * 60_000;

const FALLBACK_CODEX_CONNECTION_SLUGS = ['chatgpt-plus', 'codex'];

function isRetryableStatus(status: number, errorText: string): boolean {
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(errorText);
}

function backoffMs(attempt: number): number {
  const jitter = 0.9 + Math.random() * 0.2;
  return BASE_DELAY_MS * 2 ** (attempt - 1) * jitter;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) {
    throw new Error('OpenAI Codex auth token is not a JWT.');
  }

  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Failed to decode OpenAI Codex auth token: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function extractChatGptAccountId(token: string): string {
  const payload = decodeJwtPayload(token);
  const authClaims = payload[JWT_CLAIM_PATH];
  if (!authClaims || typeof authClaims !== 'object') {
    throw new Error('OpenAI Codex auth token does not contain ChatGPT auth claims.');
  }

  const accountId = (authClaims as Record<string, unknown>).chatgpt_account_id;
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new Error('OpenAI Codex auth token does not contain chatgpt_account_id.');
  }

  return accountId;
}

function isOpenAiCodexConnection(connection: LlmConnectionInfo): boolean {
  return connection.authType === 'oauth'
    && (connection.piAuthProvider === PROVIDER || connection.slug === 'chatgpt-plus' || connection.slug === 'codex');
}

function candidateConnectionSlugs(ctx: SessionToolContext, explicitSlug?: string): string[] {
  const candidates: Array<string | undefined> = explicitSlug ? [explicitSlug] : [
    ctx.llmConnectionSlug,
    ...((ctx.listLlmConnections?.() ?? [])
      .filter(isOpenAiCodexConnection)
      .map(connection => connection.slug)),
    ...FALLBACK_CODEX_CONNECTION_SLUGS,
  ];

  const seen = new Set<string>();
  return candidates
    .map(slug => slug?.trim())
    .filter((slug): slug is string => !!slug)
    .filter(slug => {
      if (seen.has(slug)) return false;
      seen.add(slug);
      return true;
    });
}

async function credentialForSlug(
  ctx: SessionToolContext,
  slug: string,
): Promise<{ credential: LlmOAuthCredential; accountId: string } | { error: string }> {
  const manager = ctx.llmCredentialManager;
  if (!manager) {
    return { error: 'LLM OAuth credentials are not available in this runtime.' };
  }

  let credential = await manager.getOAuth(slug);
  if (!credential?.accessToken) {
    return { error: `No OAuth token found for LLM connection "${slug}".` };
  }

  if (credential.expiresAt && credential.expiresAt < Date.now() + TOKEN_EXPIRY_SKEW_MS) {
    if (!credential.refreshToken || !manager.refreshOAuth) {
      return { error: `OAuth token for "${slug}" is expired and cannot be refreshed.` };
    }

    try {
      const refreshed = await manager.refreshOAuth(slug, credential);
      if (!refreshed?.accessToken) {
        return { error: `OAuth token refresh for "${slug}" did not return an access token.` };
      }
      credential = refreshed;
    } catch (error) {
      return { error: `OAuth token refresh for "${slug}" failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  try {
    return {
      credential,
      accountId: extractChatGptAccountId(credential.accessToken),
    };
  } catch (error) {
    return {
      error: `${error instanceof Error ? error.message : String(error)} Connection "${slug}" is not a ChatGPT Plus/Pro Codex OAuth connection.`,
    };
  }
}

async function resolveCodexAuth(
  ctx: SessionToolContext,
  explicitSlug?: string,
): Promise<{ slug: string; token: string; accountId: string } | { error: string }> {
  const slugs = candidateConnectionSlugs(ctx, explicitSlug);
  if (slugs.length === 0) {
    return {
      error: 'No ChatGPT Plus/Pro Codex OAuth connection is configured. Sign in to ChatGPT Plus/Pro in AI settings, then retry.',
    };
  }

  const failures: string[] = [];
  for (const slug of slugs) {
    const result = await credentialForSlug(ctx, slug);
    if ('credential' in result) {
      return { slug, token: result.credential.accessToken, accountId: result.accountId };
    }
    failures.push(`${slug}: ${result.error}`);
  }

  return {
    error: [
      'Unable to find a usable ChatGPT Plus/Pro Codex OAuth token.',
      `Tried: ${slugs.join(', ')}.`,
      `Failures: ${failures.join(' | ')}`,
    ].join('\n'),
  };
}

function buildRequestBody(
  prompt: string,
  model: string,
  outputFormat: CodexImageOutputFormat,
  sessionId: string,
) {
  return {
    model,
    store: false,
    stream: true,
    prompt_cache_key: sessionId || 'craft-agent',
    instructions:
      'You are generating bitmap image assets. For this request, call the image_generation tool exactly once. Do not answer with only text unless image generation is unavailable.',
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: prompt }],
      },
    ],
    tools: [{ type: 'image_generation', output_format: outputFormat }],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    text: { verbosity: 'low' },
  };
}

function parseSseDataLines(chunk: string): string | undefined {
  const data = chunk
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .join('\n')
    .trim();
  return data && data !== '[DONE]' ? data : undefined;
}

function handleCodexEvent(event: CodexSseEvent, parsed: ParsedCodexResponse): void {
  if (!event || typeof event !== 'object') return;

  switch (event.type) {
    case 'error':
      throw new Error(`Codex error: ${event.message || event.code || JSON.stringify(event)}`);
    case 'response.failed':
      throw new Error(event.response?.error?.message || 'Codex response failed.');
    case 'response.created':
      if (typeof event.response?.id === 'string') {
        parsed.responseId = event.response.id;
      }
      break;
    case 'response.output_text.delta':
      if (typeof event.delta === 'string') {
        parsed.text.push(event.delta);
      }
      break;
    case 'response.output_item.done': {
      const item = event.item;
      if (item?.type === 'image_generation_call') {
        if (typeof item.result !== 'string' || item.result.length === 0) {
          throw new Error('Codex image_generation_call did not contain image data.');
        }
        parsed.image = {
          id: String(item.id || 'image_generation'),
          status: String(item.status || 'completed'),
          result: item.result,
          revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
        };
      }
      break;
    }
    case 'response.completed':
      if (typeof event.response?.id === 'string') parsed.responseId = event.response.id;
      if (event.response?.usage) parsed.usage = event.response.usage;
      break;
  }
}

async function parseCodexSse(response: Response, signal?: AbortSignal): Promise<ParsedCodexResponse> {
  if (!response.body) throw new Error('Codex response did not include a stream body.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const parsed: ParsedCodexResponse = { text: [] };

  try {
    while (true) {
      if (signal?.aborted) throw new Error('Image generation was aborted.');
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');

      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        const chunk = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const data = parseSseDataLines(chunk);
        if (data) handleCodexEvent(JSON.parse(data) as CodexSseEvent, parsed);
        separator = buffer.indexOf('\n\n');
      }
    }

    const remaining = parseSseDataLines(buffer);
    if (remaining) handleCodexEvent(JSON.parse(remaining) as CodexSseEvent, parsed);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Stream may already be closed.
    }
    reader.releaseLock();
  }

  return parsed;
}

async function requestImage(
  prompt: string,
  token: string,
  accountId: string,
  model: string,
  outputFormat: CodexImageOutputFormat,
  sessionId: string,
  signal?: AbortSignal,
): Promise<ParsedCodexResponse> {
  const body = JSON.stringify(buildRequestBody(prompt, model, outputFormat, sessionId));
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'chatgpt-account-id': accountId,
    originator: 'pi',
    'OpenAI-Beta': OPENAI_BETA_HEADER,
    accept: 'text/event-stream',
    'content-type': 'application/json',
  };

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    if (signal?.aborted) throw new Error('Image generation was aborted.');

    const response = await fetch(CODEX_RESPONSES_URL, {
      method: 'POST',
      headers,
      body,
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (attempt <= MAX_RETRIES && isRetryableStatus(response.status, errorText)) {
        await new Promise<void>(resolve => setTimeout(resolve, backoffMs(attempt)));
        continue;
      }
      throw new Error(`Codex image generation request failed (${response.status}): ${errorText}`);
    }

    return parseCodexSse(response, signal);
  }

  throw new Error('Codex image generation request failed after all retries.');
}

function extensionForFormat(outputFormat: CodexImageOutputFormat): string {
  return outputFormat === 'jpeg' ? 'jpg' : outputFormat;
}

function sanitizePathPart(value: string | undefined, fallback: string): string {
  const sanitized = (value || '')
    .split('')
    .map(ch => (/[a-zA-Z0-9_-]/.test(ch) ? ch : '_'))
    .join('')
    .replace(/^_+/g, '')
    .replace(/_+$/g, '');
  return sanitized || fallback;
}

function outputFilePath(ctx: SessionToolContext, args: CodexGenerateImageArgs, imageId: string): string {
  if (!ctx.dataPath) {
    throw new Error('codex_generate_image requires dataPath in context.');
  }

  const outputDir = join(ctx.dataPath, 'codex-images');
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const fileStem = args.fileName
    ? sanitizePathPart(parse(args.fileName).name, 'codex_image')
    : sanitizePathPart(imageId, 'image_generation');
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  return join(outputDir, `${timestamp}-${fileStem}.${extensionForFormat(args.outputFormat || 'png')}`);
}

function writeImageToSessionData(
  ctx: SessionToolContext,
  args: CodexGenerateImageArgs,
  image: GeneratedImage,
): { path: string; byteCount: number } {
  const filePath = outputFilePath(ctx, args, image.id);
  const buffer = Buffer.from(image.result, 'base64');
  writeFileSync(filePath, buffer);
  return { path: filePath, byteCount: buffer.byteLength };
}

/**
 * Handle the codex_generate_image tool call.
 */
export async function handleCodexGenerateImage(
  ctx: SessionToolContext,
  args: CodexGenerateImageArgs,
): Promise<ToolResult> {
  if (!args.prompt?.trim()) {
    return errorResponse('prompt is required.');
  }

  if (!ctx.dataPath) {
    return errorResponse('codex_generate_image requires a desktop session context with dataPath.');
  }

  if (!ctx.llmCredentialManager) {
    return errorResponse('codex_generate_image requires desktop LLM OAuth credentials. Sign in to ChatGPT Plus/Pro in AI settings, then retry.');
  }

  const outputFormat = args.outputFormat || 'png';
  const model = args.model?.trim() || DEFAULT_MODEL;
  const auth = await resolveCodexAuth(ctx, args.connectionSlug);
  if ('error' in auth) {
    return errorResponse(auth.error);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const parsed = await requestImage(
      args.prompt.trim(),
      auth.token,
      auth.accountId,
      model,
      outputFormat,
      ctx.sessionId,
      controller.signal,
    );

    if (!parsed.image) {
      const text = parsed.text.join('').trim();
      return errorResponse(text ? `Codex did not return an image. Response text: ${text}` : 'Codex did not return an image.');
    }

    const saved = writeImageToSessionData(ctx, { ...args, outputFormat }, parsed.image);
    const lines = [
      `Generated image via ${PROVIDER}/${model} using backend ${BACKEND_IMAGE_MODEL}.`,
      `LLM connection: ${auth.slug}.`,
      `Status: ${parsed.image.status}.`,
      `Saved image to: ${saved.path} (${Math.round(saved.byteCount / 1024)} KB).`,
    ];

    if (parsed.image.revisedPrompt) {
      lines.push(`Revised prompt: ${parsed.image.revisedPrompt}`);
    }
    if (parsed.responseId) {
      lines.push(`Response ID: ${parsed.responseId}.`);
    }

    lines.push(
      '',
      '```image-preview',
      JSON.stringify({ src: saved.path, title: 'Codex Generated Image' }, null, 2),
      '```',
    );

    return successResponse(lines.join('\n'));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return errorResponse(`Codex image generation failed: ${msg}`);
  } finally {
    clearTimeout(timeout);
  }
}
