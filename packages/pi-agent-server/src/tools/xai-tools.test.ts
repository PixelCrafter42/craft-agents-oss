import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createXaiTools, type XaiToolUsage } from './xai-tools.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function textFromResult(result: any): string {
  return result.content.find((part: any) => part.type === 'text')?.text ?? '';
}

describe('xAI tools', () => {
  it('xai_web_search calls xAI Responses with native web_search', async () => {
    let calledBody: any;
    const usageEvents: XaiToolUsage[] = [];
    globalThis.fetch = async (_url, init) => {
      calledBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: 'resp-search-1',
        output_text: 'search result with sources',
        usage: {
          input_tokens: 199,
          output_tokens: 11,
          total_tokens: 210,
          input_tokens_details: { cached_tokens: 20 },
          cost_in_usd_ticks: 37_756_000,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const tools = createXaiTools({
      cwd: process.cwd(),
      getSessionPath: () => null,
      resolveApiKey: async () => 'xai-token',
      onUsage: usage => usageEvents.push(usage),
    });
    const tool = tools.find(t => t.name === 'xai_web_search')!;
    const result = await tool.execute('tool-1', { query: 'latest Grok news' });

    expect(calledBody.model).toBe('grok-4.5');
    expect(calledBody.tools).toEqual([{ type: 'web_search', enable_image_understanding: true }]);
    expect(textFromResult(result)).toContain('search result with sources');
    expect(usageEvents).toEqual([{
      usageId: 'resp-search-1',
      provider: 'xai',
      model: 'grok-4.5',
      inputTokens: 199,
      outputTokens: 11,
      totalTokens: 210,
      cacheReadTokens: 20,
      costUsd: 0.0037756,
    }]);
  });

  it('xai_generate_image saves base64 image responses to session downloads', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'craft-xai-tool-'));
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x00,
    ]);
    let calledBody: any;
    const usageEvents: XaiToolUsage[] = [];

    globalThis.fetch = async (_url, init) => {
      calledBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: 'image-1',
        data: [{ b64_json: png.toString('base64') }],
        usage: { cost_in_usd_ticks: 500_000_000 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const tools = createXaiTools({
      cwd: process.cwd(),
      getSessionPath: () => sessionPath,
      resolveApiKey: async () => 'xai-token',
      onUsage: usage => usageEvents.push(usage),
    });
    const tool = tools.find(t => t.name === 'xai_generate_image')!;
    const result = await tool.execute('tool-2', { prompt: 'a small test image' });
    const text = textFromResult(result);
    const match = text.match(/- (.*xai-generated.*\.jpg)/);

    expect(calledBody.response_format).toBe('b64_json');
    expect(match?.[1]).toBeTruthy();
    expect(existsSync(match![1]!)).toBe(true);
    expect(text).toContain('![xAI generated image]');
    expect(usageEvents).toEqual([{
      usageId: 'image-1',
      provider: 'xai',
      model: 'grok-imagine-image-quality',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0.05,
    }]);
  });

  it('records billed usage returned with an error response', async () => {
    const usageEvents: XaiToolUsage[] = [];
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: { message: 'request rejected' },
      usage: { cost_in_usd_ticks: 500_000_000 },
    }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });

    const tools = createXaiTools({
      cwd: process.cwd(),
      getSessionPath: () => null,
      resolveApiKey: async () => 'xai-token',
      onUsage: usage => usageEvents.push(usage),
    });
    const tool = tools.find(t => t.name === 'xai_web_search')!;
    const result = await tool.execute('tool-error', { query: 'rejected query' });

    expect(textFromResult(result)).toContain('request rejected');
    expect(usageEvents).toEqual([{
      usageId: 'tool-error',
      provider: 'xai',
      model: 'grok-4.5',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0.05,
    }]);
  });

  it('preserves an authoritative zero billed cost instead of estimating it later', async () => {
    const usageEvents: XaiToolUsage[] = [];
    globalThis.fetch = async () => new Response(JSON.stringify({
      id: 'resp-free-1',
      output_text: 'free response',
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        total_tokens: 12,
        cost_in_usd_ticks: 0,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    const tools = createXaiTools({
      cwd: process.cwd(),
      getSessionPath: () => null,
      resolveApiKey: async () => 'xai-token',
      onUsage: usage => usageEvents.push(usage),
    });
    const tool = tools.find(t => t.name === 'xai_web_search')!;
    await tool.execute('tool-free', { query: 'free query' });

    expect(usageEvents).toEqual([expect.objectContaining({
      usageId: 'resp-free-1',
      totalTokens: 12,
      costUsd: 0,
    })]);
  });
});
