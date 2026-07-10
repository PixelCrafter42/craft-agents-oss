import { Type } from '@sinclair/typebox';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveBinaryResponse } from '../../../shared/src/utils/binary-detection.ts';

const XAI_RESPONSES_URL = 'https://api.x.ai/v1/responses';
const XAI_IMAGES_GENERATIONS_URL = 'https://api.x.ai/v1/images/generations';
const DEFAULT_XAI_MODEL = 'grok-4.5';
const DEFAULT_XAI_IMAGE_MODEL = 'grok-imagine-image-quality';
const MAX_IMAGE_DOWNLOAD_BYTES = 50 * 1024 * 1024;

const webSearchSchema = Type.Object({
  query: Type.String({ description: 'Web research query' }),
});

const xSearchSchema = Type.Object({
  query: Type.String({ description: 'X search query' }),
  count: Type.Optional(Type.Number({ minimum: 1, maximum: 20, description: 'Approximate number of posts to summarize' })),
  since: Type.Optional(Type.String({ description: 'Only include posts after this date (YYYY-MM-DD)' })),
  until: Type.Optional(Type.String({ description: 'Only include posts before this date (YYYY-MM-DD)' })),
});

const deepResearchSchema = Type.Object({
  topic: Type.String({ description: 'Research topic or question' }),
  depth: Type.Optional(Type.String({ description: 'Research depth: low, medium, or high' })),
});

const generateImageSchema = Type.Object({
  prompt: Type.String({ description: 'Detailed image prompt' }),
  model: Type.Optional(Type.String({ description: 'Image model to use' })),
  n: Type.Optional(Type.Number({ minimum: 1, maximum: 4, description: 'Number of images to generate (1-4)' })),
  aspect_ratio: Type.Optional(Type.String({ description: 'Aspect ratio such as 1:1, 16:9, 9:16, 4:3, or auto' })),
  resolution: Type.Optional(Type.String({ description: 'Image resolution: 1k or 2k' })),
});

const analyzeImageSchema = Type.Object({
  image: Type.String({ description: 'Image URL, local file path, file:// URL, or data:image base64 URL' }),
  question: Type.Optional(Type.String({ description: 'Question to ask about the image' })),
});

export interface XaiToolsOptions {
  resolveApiKey: () => Promise<string | null>;
  getSessionPath: () => string | null;
  cwd: string;
  onUsage?: (usage: XaiToolUsage) => void;
}

export interface XaiToolUsage {
  usageId: string;
  provider: 'xai';
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  costUsd?: number;
}

function usageNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 0;
}

function optionalUsageNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function reportUsage(
  onUsage: XaiToolsOptions['onUsage'],
  data: unknown,
  model: string,
  fallbackUsageId: string,
): void {
  if (!onUsage || !data || typeof data !== 'object') return;
  const response = data as Record<string, unknown>;
  const rawUsage = response.usage;
  if (!rawUsage || typeof rawUsage !== 'object') return;
  const usage = rawUsage as Record<string, unknown>;
  const inputTokens = usageNumber(usage.input_tokens);
  const outputTokens = usageNumber(usage.output_tokens);
  const totalTokens = usageNumber(usage.total_tokens) || inputTokens + outputTokens;
  const details = usage.input_tokens_details && typeof usage.input_tokens_details === 'object'
    ? usage.input_tokens_details as Record<string, unknown>
    : undefined;
  const cacheReadTokens = usageNumber(details?.cached_tokens);
  // Presence matters: an explicit zero is an authoritative billed cost and
  // must not fall through to local price estimation.
  const costTicks = optionalUsageNumber(usage.cost_in_usd_ticks);
  if (totalTokens === 0 && costTicks === undefined) return;
  const responseId = typeof response.id === 'string' && response.id ? response.id : fallbackUsageId;

  onUsage({
    usageId: responseId,
    provider: 'xai',
    model,
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(costTicks !== undefined ? { costUsd: costTicks / 10_000_000_000 } : {}),
  });
}

function result(text: string, isError = false, details: Record<string, unknown> = {}): AgentToolResult<any> {
  return {
    content: [{ type: 'text', text }],
    details: isError ? { ...details, isError: true } : details,
  };
}

function textInput(text: string): Array<{ role: 'user'; content: string }> {
  return [{ role: 'user', content: text }];
}

function compactErrorText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 800) : 'Unknown error';
}

async function postXaiJson(
  apiKey: string,
  url: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  onResponse?: (data: unknown) => void,
): Promise<any> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  const text = await response.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  // xAI can return billed usage for rejected requests too (for example a
  // guideline-violation fee), so report it before checking response.ok.
  onResponse?.(data);

  if (!response.ok) {
    let message = text;
    if (data && typeof data === 'object') {
      const errorJson = data as Record<string, any>;
      message = errorJson?.error?.message || errorJson?.error_description || errorJson?.error || text;
    }
    const error = new Error(compactErrorText(message));
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }

  return data;
}

function extractResponsesText(data: any): string {
  if (typeof data?.output_text === 'string' && data.output_text) return data.output_text;
  const chunks: string[] = [];
  for (const item of data?.output || []) {
    if (typeof item?.text === 'string') chunks.push(item.text);
    for (const part of item?.content || []) {
      if (typeof part?.text === 'string') chunks.push(part.text);
    }
  }
  return chunks.join('') || JSON.stringify(data, null, 2);
}

function xaiErrorMessage(prefix: string, error: unknown): string {
  const status = typeof (error as { status?: unknown })?.status === 'number'
    ? ` HTTP ${(error as { status: number }).status}`
    : '';
  const message = error instanceof Error ? error.message : String(error);
  return `${prefix}${status}: ${message}`;
}

async function resolveRequiredApiKey(resolveApiKey: () => Promise<string | null>): Promise<string> {
  const apiKey = await resolveApiKey();
  if (!apiKey) {
    throw new Error('No xAI OAuth credentials found. Connect xAI / Grok in Settings first.');
  }
  return apiKey;
}

function normalizeDepth(value: unknown): 'low' | 'medium' | 'high' {
  return value === 'low' || value === 'medium' || value === 'high' ? value : 'high';
}

function normalizeCount(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 5;
  return Math.max(1, Math.min(20, n));
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
      throw new Error('xAI image analysis supports local .jpg, .jpeg, .png, and .webp files');
  }
}

async function normalizeImageInput(value: string, cwd: string): Promise<string> {
  const cleaned = stripShellQuotes(value);
  if (/^https?:\/\//i.test(cleaned) || /^data:image\//i.test(cleaned)) {
    return cleaned;
  }

  let localPath = unescapeShellPath(cleaned);
  if (localPath.startsWith('file://')) {
    localPath = fileURLToPath(localPath);
  }
  if (!isAbsolute(localPath)) {
    localPath = resolve(cwd, localPath);
  }

  const mimeType = imageMimeTypeForPath(localPath);
  const buffer = await readFile(localPath);
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

function mimeToExtension(mimeType: string | null): string {
  switch ((mimeType || '').split(';')[0]?.trim().toLowerCase()) {
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg';
    default:
      return '.jpg';
  }
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    const ab = await response.arrayBuffer();
    if (ab.byteLength > maxBytes) throw new Error(`Image exceeded ${Math.round(maxBytes / 1024 / 1024)}MB limit`);
    return Buffer.from(ab);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) throw new Error(`Image exceeded ${Math.round(maxBytes / 1024 / 1024)}MB limit`);
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
}

function parseDataImage(value: string): { buffer: Buffer; mimeType: string } | null {
  const match = value.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1]!, buffer: Buffer.from(match[2]!, 'base64') };
}

async function imageEntryToBuffer(entry: any, signal?: AbortSignal): Promise<{ buffer: Buffer; mimeType: string | null }> {
  const b64 = entry?.b64_json || entry?.base64 || entry?.image_base64;
  if (typeof b64 === 'string' && b64) {
    const asData = parseDataImage(b64);
    if (asData) return asData;
    return { buffer: Buffer.from(b64, 'base64'), mimeType: 'image/jpeg' };
  }

  if (typeof entry?.image === 'string' && entry.image) {
    const asData = parseDataImage(entry.image);
    if (asData) return asData;
    return { buffer: Buffer.from(entry.image, 'base64'), mimeType: 'image/jpeg' };
  }

  const url = entry?.url || entry?.image_url;
  if (typeof url === 'string' && url) {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Failed to download generated image: HTTP ${response.status}`);
    const contentType = response.headers.get('content-type');
    return { buffer: await readResponseBytes(response, MAX_IMAGE_DOWNLOAD_BYTES), mimeType: contentType };
  }

  throw new Error('xAI image response did not include base64 data or a URL');
}

function collectImageEntries(data: any): any[] {
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.images)) return data.images;
  if (data?.url || data?.b64_json || data?.base64 || data?.image || data?.image_url) return [data];
  return [];
}

function saveGeneratedImage(sessionPath: string, index: number, buffer: Buffer, mimeType: string | null): string {
  const ext = mimeToExtension(mimeType);
  const saved = saveBinaryResponse(
    sessionPath,
    `xai-generated-${Date.now()}-${index + 1}${ext}`,
    buffer,
    mimeType,
  );
  if (saved.type === 'file_download_error') {
    throw new Error(saved.error);
  }
  return saved.path;
}

export function createXaiTools(options: XaiToolsOptions): ToolDefinition<any, any>[] {
  const { resolveApiKey, getSessionPath, cwd, onUsage } = options;

  return [
    {
      name: 'xai_web_search',
      label: 'xAI Web Search',
      description: 'Search the web using Grok native real-time web search. Returns concise findings with sources, dates, and summaries.',
      promptSnippet: 'Use xai_web_search for Grok native real-time web search when xAI/Grok subscription search is requested.',
      parameters: webSearchSchema,
      async execute(toolCallId, params: any, signal?: AbortSignal) {
        try {
          const apiKey = await resolveRequiredApiKey(resolveApiKey);
          const query = String(params.query || '').trim();
          const data = await postXaiJson(apiKey, XAI_RESPONSES_URL, {
            model: DEFAULT_XAI_MODEL,
            input: textInput(`Search the web for: ${query}\n\nReturn sources, dates, short summaries, and the most important recent developments. Prioritize authoritative sources.`),
            reasoning: { effort: 'medium' },
            tools: [{ type: 'web_search', enable_image_understanding: true }],
          }, signal, response => reportUsage(onUsage, response, DEFAULT_XAI_MODEL, toolCallId));
          return result(extractResponsesText(data), false, { query });
        } catch (error) {
          return result(xaiErrorMessage('xAI web search failed', error), true);
        }
      },
    },
    {
      name: 'xai_x_search',
      label: 'xAI X Search',
      description: 'Search X using Grok native X search. Returns posts, users, trends, sentiment, and timeline summaries.',
      promptSnippet: 'Use xai_x_search for Grok native X/Twitter search, trends, sentiment, and timeline summaries.',
      parameters: xSearchSchema,
      async execute(toolCallId, params: any, signal?: AbortSignal) {
        try {
          const apiKey = await resolveRequiredApiKey(resolveApiKey);
          const query = String(params.query || '').trim();
          const count = normalizeCount(params.count);
          const tool: Record<string, unknown> = { type: 'x_search', enable_image_understanding: true };
          if (params.since) tool.from_date = String(params.since);
          if (params.until) tool.to_date = String(params.until);

          const data = await postXaiJson(apiKey, XAI_RESPONSES_URL, {
            model: DEFAULT_XAI_MODEL,
            input: textInput(
              `Search X for: ${query}\n\nReturn up to ${count} relevant posts with users, timestamps, engagement if available, key quotes, trend summary, timeline, and overall sentiment.`,
            ),
            reasoning: { effort: 'medium' },
            tools: [tool],
          }, signal, response => reportUsage(onUsage, response, DEFAULT_XAI_MODEL, toolCallId));
          return result(extractResponsesText(data), false, { query, count });
        } catch (error) {
          return result(xaiErrorMessage('xAI X search failed', error), true);
        }
      },
    },
    {
      name: 'xai_deep_research',
      label: 'xAI Deep Research',
      description: 'Combine Grok web search and X search with higher reasoning to produce a synthesized research report.',
      promptSnippet: 'Use xai_deep_research for broader research that should combine web sources, X discussion, and high-reasoning synthesis.',
      parameters: deepResearchSchema,
      async execute(toolCallId, params: any, signal?: AbortSignal) {
        try {
          const apiKey = await resolveRequiredApiKey(resolveApiKey);
          const topic = String(params.topic || '').trim();
          const depth = normalizeDepth(params.depth);
          const data = await postXaiJson(apiKey, XAI_RESPONSES_URL, {
            model: DEFAULT_XAI_MODEL,
            input: textInput(
              `Conduct ${depth} depth research on: ${topic}\n\nCombine web sources and X discussion. Include key facts, recent developments, source citations, notable posts/users when relevant, competing perspectives, risks, and concise conclusions.`,
            ),
            reasoning: { effort: depth === 'high' ? 'high' : 'medium' },
            tools: [
              { type: 'web_search', enable_image_understanding: true },
              { type: 'x_search', enable_image_understanding: true },
            ],
          }, signal, response => reportUsage(onUsage, response, DEFAULT_XAI_MODEL, toolCallId));
          return result(extractResponsesText(data), false, { topic, depth });
        } catch (error) {
          return result(xaiErrorMessage('xAI deep research failed', error), true);
        }
      },
    },
    {
      name: 'xai_generate_image',
      label: 'xAI Image Generation',
      description: 'Generate images with Grok Imagine and immediately save them to the current Craft session downloads.',
      promptSnippet: 'Use xai_generate_image to generate images with Grok Imagine. Generated images are saved to the session downloads directory and returned as local image paths.',
      parameters: generateImageSchema,
      async execute(toolCallId, params: any, signal?: AbortSignal) {
        try {
          const sessionPath = getSessionPath();
          if (!sessionPath) throw new Error('No active session path available for saving generated images');
          const apiKey = await resolveRequiredApiKey(resolveApiKey);
          const n = Math.max(1, Math.min(4, Math.round(Number(params.n || 1))));
          const body: Record<string, unknown> = {
            model: params.model || DEFAULT_XAI_IMAGE_MODEL,
            prompt: String(params.prompt || ''),
            n,
            response_format: 'b64_json',
          };
          if (params.aspect_ratio) body.aspect_ratio = String(params.aspect_ratio);
          if (params.resolution) body.resolution = String(params.resolution);

          const data = await postXaiJson(
            apiKey,
            XAI_IMAGES_GENERATIONS_URL,
            body,
            signal,
            response => reportUsage(onUsage, response, String(body.model), toolCallId),
          );
          const entries = collectImageEntries(data);
          if (entries.length === 0) {
            return result('xAI image generation completed, but no image data or URL was returned.', true, { prompt: params.prompt });
          }

          const savedPaths: string[] = [];
          for (let i = 0; i < entries.length; i++) {
            const { buffer, mimeType } = await imageEntryToBuffer(entries[i], signal);
            savedPaths.push(saveGeneratedImage(sessionPath, i, buffer, mimeType));
          }

          const list = savedPaths.map(path => `- ${path}`).join('\n');
          const markdown = savedPaths.map(path => `![xAI generated image](${path})`).join('\n');
          return result(
            `Generated ${savedPaths.length} image(s) and saved them:\n${list}\n\n${markdown}`,
            false,
            { prompt: params.prompt, paths: savedPaths },
          );
        } catch (error) {
          return result(xaiErrorMessage('xAI image generation failed', error), true);
        }
      },
    },
    {
      name: 'xai_analyze_image',
      label: 'xAI Image Analysis',
      description: 'Upload an image to Grok vision for analysis. Accepts URL, local image path, file:// URL, or data:image base64 URL.',
      promptSnippet: 'Use xai_analyze_image to analyze a user-specified image with Grok vision. This uploads the image content to xAI when a local path or data URL is provided.',
      parameters: analyzeImageSchema,
      async execute(toolCallId, params: any, signal?: AbortSignal) {
        try {
          const apiKey = await resolveRequiredApiKey(resolveApiKey);
          const imageUrl = await normalizeImageInput(String(params.image || ''), cwd);
          const question = String(params.question || 'Describe this image in detail, including objects, text, style, context, and notable details.');
          const data = await postXaiJson(apiKey, XAI_RESPONSES_URL, {
            model: DEFAULT_XAI_MODEL,
            input: [
              {
                role: 'user',
                content: [
                  { type: 'input_image', image_url: imageUrl, detail: 'high' },
                  { type: 'input_text', text: question },
                ],
              },
            ],
            reasoning: { effort: 'medium' },
          }, signal, response => reportUsage(onUsage, response, DEFAULT_XAI_MODEL, toolCallId));
          return result(extractResponsesText(data), false, { image: params.image, question });
        } catch (error) {
          return result(xaiErrorMessage('xAI image analysis failed', error), true);
        }
      },
    },
  ];
}
