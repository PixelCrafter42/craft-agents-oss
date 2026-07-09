import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createXaiTools } from './xai-tools.ts';

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
    globalThis.fetch = async (_url, init) => {
      calledBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ output_text: 'search result with sources' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const tools = createXaiTools({
      cwd: process.cwd(),
      getSessionPath: () => null,
      resolveApiKey: async () => 'xai-token',
    });
    const tool = tools.find(t => t.name === 'xai_web_search')!;
    const result = await tool.execute('tool-1', { query: 'latest Grok news' });

    expect(calledBody.model).toBe('grok-4.5');
    expect(calledBody.tools).toEqual([{ type: 'web_search', enable_image_understanding: true }]);
    expect(textFromResult(result)).toContain('search result with sources');
  });

  it('xai_generate_image saves base64 image responses to session downloads', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'craft-xai-tool-'));
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x00,
    ]);
    let calledBody: any;

    globalThis.fetch = async (_url, init) => {
      calledBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        data: [{ b64_json: png.toString('base64') }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const tools = createXaiTools({
      cwd: process.cwd(),
      getSessionPath: () => sessionPath,
      resolveApiKey: async () => 'xai-token',
    });
    const tool = tools.find(t => t.name === 'xai_generate_image')!;
    const result = await tool.execute('tool-2', { prompt: 'a small test image' });
    const text = textFromResult(result);
    const match = text.match(/- (.*xai-generated.*\.jpg)/);

    expect(calledBody.response_format).toBe('b64_json');
    expect(match?.[1]).toBeTruthy();
    expect(existsSync(match![1]!)).toBe(true);
    expect(text).toContain('![xAI generated image]');
  });
});
