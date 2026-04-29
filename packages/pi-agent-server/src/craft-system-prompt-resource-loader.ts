import {
  DefaultResourceLoader as PiDefaultResourceLoader,
  SettingsManager as PiSettingsManager,
} from '@mariozechner/pi-coding-agent';
import type {
  ResourceLoader,
  SettingsManager as PiSettingsManagerType,
} from '@mariozechner/pi-coding-agent';

export class CraftSystemPromptResourceLoader implements ResourceLoader {
  private craftSystemPrompt: string | undefined;

  constructor(
    private readonly delegate: ResourceLoader,
    craftSystemPrompt: string | undefined,
  ) {
    this.setSystemPrompt(craftSystemPrompt);
  }

  setSystemPrompt(systemPrompt: string | undefined): void {
    const trimmed = systemPrompt?.trim();
    this.craftSystemPrompt = trimmed ? systemPrompt : undefined;
  }

  getExtensions(): ReturnType<ResourceLoader['getExtensions']> {
    return this.delegate.getExtensions();
  }

  getSkills(): ReturnType<ResourceLoader['getSkills']> {
    return this.delegate.getSkills();
  }

  getPrompts(): ReturnType<ResourceLoader['getPrompts']> {
    return this.delegate.getPrompts();
  }

  getThemes(): ReturnType<ResourceLoader['getThemes']> {
    return this.delegate.getThemes();
  }

  getAgentsFiles(): ReturnType<ResourceLoader['getAgentsFiles']> {
    return this.delegate.getAgentsFiles();
  }

  getSystemPrompt(): string | undefined {
    return this.craftSystemPrompt ?? this.delegate.getSystemPrompt();
  }

  getAppendSystemPrompt(): string[] {
    return this.delegate.getAppendSystemPrompt();
  }

  extendResources(paths: Parameters<ResourceLoader['extendResources']>[0]): void {
    this.delegate.extendResources(paths);
  }

  reload(): Promise<void> {
    return this.delegate.reload();
  }
}

export async function createCraftSystemPromptResourceLoader(
  cwd: string,
  agentDir: string,
  systemPrompt: string | undefined,
): Promise<{
  resourceLoader: CraftSystemPromptResourceLoader;
  settingsManager: PiSettingsManagerType;
}> {
  const settingsManager = PiSettingsManager.create(cwd, agentDir);
  const delegate = new PiDefaultResourceLoader({ cwd, agentDir, settingsManager });
  const resourceLoader = new CraftSystemPromptResourceLoader(delegate, systemPrompt);
  await resourceLoader.reload();
  return { resourceLoader, settingsManager };
}
