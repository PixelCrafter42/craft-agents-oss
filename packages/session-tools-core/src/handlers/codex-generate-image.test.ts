import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmOAuthCredential, SessionToolContext } from '../context.ts';
import { handleCodexGenerateImage } from './codex-generate-image.ts';

const originalFetch = globalThis.fetch;

function jwtWithAccountId(accountId: string): string {
  const payload = {
    'https://api.openai.com/auth': {
      chatgpt_account_id: accountId,
    },
  };
  return [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}

function sseResponse(events: unknown[]): Response {
  const text = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function createContext(
  dataPath: string,
  options: {
    llmConnectionSlug?: string;
    getOAuth?: (slug: string) => Promise<LlmOAuthCredential | null>;
    refreshOAuth?: (slug: string, credential: LlmOAuthCredential) => Promise<LlmOAuthCredential | null>;
    listLlmConnections?: SessionToolContext['listLlmConnections'];
  },
): SessionToolContext {
  return {
    sessionId: 'session-123',
    workspacePath: dataPath,
    sourcesPath: join(dataPath, 'sources'),
    skillsPath: join(dataPath, 'skills'),
    plansFolderPath: join(dataPath, 'plans'),
    callbacks: {
      onPlanSubmitted: () => {},
      onAuthRequest: () => {},
    },
    fs: {
      exists: () => false,
      readFile: () => '',
      readFileBuffer: () => Buffer.from(''),
      writeFile: () => {},
      isDirectory: () => false,
      readdir: () => [],
      stat: () => ({ size: 0, isDirectory: () => false }),
    },
    loadSourceConfig: () => null,
    dataPath,
    sessionPath: join(dataPath, 'session'),
    llmConnectionSlug: options.llmConnectionSlug,
    llmCredentialManager: {
      getOAuth: options.getOAuth ?? (async () => null),
      refreshOAuth: options.refreshOAuth,
    },
    listLlmConnections: options.listLlmConnections,
  };
}

describe('handleCodexGenerateImage', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'codex-image-test-'));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('generates, saves, and returns an image-preview block', async () => {
    const token = jwtWithAccountId('acct_123');
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    let requestInit: RequestInit | undefined;

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestInit = init;
      return sseResponse([
        { type: 'response.created', response: { id: 'resp_1' } },
        {
          type: 'response.output_item.done',
          item: {
            type: 'image_generation_call',
            id: 'img_1',
            status: 'completed',
            result: imageBytes.toString('base64'),
            revised_prompt: 'A revised prompt',
          },
        },
        { type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 1 } } },
      ]);
    }) as unknown as typeof fetch;

    const ctx = createContext(tempDir, {
      llmConnectionSlug: 'chatgpt-plus',
      getOAuth: async slug => slug === 'chatgpt-plus' ? { accessToken: token } : null,
    });

    const result = await handleCodexGenerateImage(ctx, {
      prompt: 'A small red square icon',
      outputFormat: 'png',
    });

    expect(result.isError).toBe(false);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Generated image via openai-codex/gpt-5.5');
    expect(text).toContain('```image-preview');

    const savedPath = text.match(/Saved image to: (.+?\.png)/)?.[1];
    expect(savedPath).toBeTruthy();
    expect(existsSync(savedPath!)).toBe(true);
    expect(Buffer.compare(readFileSync(savedPath!), imageBytes)).toBe(0);

    const headers = requestInit!.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    expect(headers['chatgpt-account-id']).toBe('acct_123');
    expect(headers['OpenAI-Beta']).toBe('responses=experimental');

    const body = JSON.parse(requestInit!.body as string);
    expect(body.tools).toEqual([{ type: 'image_generation', output_format: 'png' }]);
    expect(body.prompt_cache_key).toBe('session-123');
  });

  it('discovers configured openai-codex OAuth connections when current session is not Codex', async () => {
    const token = jwtWithAccountId('acct_discovered');
    const attemptedSlugs: string[] = [];

    globalThis.fetch = (async () => sseResponse([
      {
        type: 'response.output_item.done',
        item: {
          type: 'image_generation_call',
          id: 'img_discovered',
          status: 'completed',
          result: Buffer.from('image').toString('base64'),
        },
      },
    ])) as unknown as typeof fetch;

    const ctx = createContext(tempDir, {
      llmConnectionSlug: 'claude-max',
      listLlmConnections: () => [
        { slug: 'chatgpt-plus-2', providerType: 'pi', authType: 'oauth', piAuthProvider: 'openai-codex' },
      ],
      getOAuth: async slug => {
        attemptedSlugs.push(slug);
        return slug === 'chatgpt-plus-2' ? { accessToken: token } : null;
      },
    });

    const result = await handleCodexGenerateImage(ctx, { prompt: 'Generate a badge' });

    expect(result.isError).toBe(false);
    expect(attemptedSlugs).toEqual(['claude-max', 'chatgpt-plus-2']);
    expect(result.content[0]?.text).toContain('LLM connection: chatgpt-plus-2');
  });

  it('refreshes an expired ChatGPT OAuth token before making the request', async () => {
    const expiredToken = jwtWithAccountId('acct_old');
    const freshToken = jwtWithAccountId('acct_new');
    let refreshed = false;
    let authorizationHeader = '';

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init!.headers as Record<string, string>;
      authorizationHeader = headers.Authorization;
      return sseResponse([
        {
          type: 'response.output_item.done',
          item: {
            type: 'image_generation_call',
            id: 'img_refreshed',
            status: 'completed',
            result: Buffer.from('image').toString('base64'),
          },
        },
      ]);
    }) as unknown as typeof fetch;

    const ctx = createContext(tempDir, {
      llmConnectionSlug: 'chatgpt-plus',
      getOAuth: async () => ({
        accessToken: expiredToken,
        refreshToken: 'refresh-token',
        expiresAt: Date.now() - 1000,
      }),
      refreshOAuth: async (_slug, credential) => {
        expect(credential.refreshToken).toBe('refresh-token');
        refreshed = true;
        return { accessToken: freshToken, refreshToken: 'refresh-token-2', expiresAt: Date.now() + 3600_000 };
      },
    });

    const result = await handleCodexGenerateImage(ctx, { prompt: 'Generate a texture' });

    expect(result.isError).toBe(false);
    expect(refreshed).toBe(true);
    expect(authorizationHeader).toBe(`Bearer ${freshToken}`);
  });
});
