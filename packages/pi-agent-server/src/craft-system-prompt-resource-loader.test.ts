import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import type { ResourceLoader } from '@mariozechner/pi-coding-agent';
import { CraftSystemPromptResourceLoader } from './craft-system-prompt-resource-loader.ts';

function createFakeResourceLoader(systemPrompt = 'sdk base prompt'): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: {} } as ReturnType<ResourceLoader['getExtensions']>),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [{ path: 'AGENTS.md', content: 'project context' }] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => ['append prompt'],
    extendResources: () => {},
    reload: async () => {},
  };
}

describe('CraftSystemPromptResourceLoader', () => {
  it('returns the current Craft system prompt instead of the delegated default prompt', () => {
    const loader = new CraftSystemPromptResourceLoader(createFakeResourceLoader(), 'craft base prompt');

    expect(loader.getSystemPrompt()).toBe('craft base prompt');

    loader.setSystemPrompt('updated craft base prompt');
    expect(loader.getSystemPrompt()).toBe('updated craft base prompt');
  });

  it('falls back to the delegated system prompt when the Craft prompt is empty', () => {
    const loader = new CraftSystemPromptResourceLoader(createFakeResourceLoader('sdk fallback'), '   ');

    expect(loader.getSystemPrompt()).toBe('sdk fallback');

    loader.setSystemPrompt('craft prompt');
    expect(loader.getSystemPrompt()).toBe('craft prompt');

    loader.setSystemPrompt(undefined);
    expect(loader.getSystemPrompt()).toBe('sdk fallback');
  });

  it('delegates non-system-prompt resources to the wrapped loader', async () => {
    const calls = { extendResources: 0, reload: 0 };
    const delegate = createFakeResourceLoader();
    delegate.extendResources = () => {
      calls.extendResources++;
    };
    delegate.reload = async () => {
      calls.reload++;
    };

    const loader = new CraftSystemPromptResourceLoader(delegate, 'craft base prompt');

    expect(loader.getAppendSystemPrompt()).toEqual(['append prompt']);
    expect(loader.getAgentsFiles()).toEqual({
      agentsFiles: [{ path: 'AGENTS.md', content: 'project context' }],
    });

    loader.extendResources({});
    await loader.reload();

    expect(calls).toEqual({ extendResources: 1, reload: 1 });
  });
});

describe('Pi system prompt integration contract', () => {
  it('uses the loader and public session API instead of writing private agent state', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('agent.state.systemPrompt');
    expect(source).toContain('createCraftSystemPromptResourceLoader');
    expect(source).toContain('setActiveToolsByName(session.getActiveToolNames())');
  });
});
