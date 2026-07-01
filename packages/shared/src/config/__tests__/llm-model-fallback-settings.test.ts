import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import type { LlmConnection } from '../llm-connections.ts'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

function makeConnection(slug: string, models: string[] = ['model-a']): LlmConnection {
  return {
    slug,
    name: slug,
    providerType: 'pi',
    authType: 'api_key',
    createdAt: Date.now(),
    models,
    defaultModel: models[0],
  }
}

function setupConfig(llmConnections: LlmConnection[]) {
  const configDir = mkdtempSync(join(tmpdir(), 'craft-agent-fallback-settings-'))
  const workspaceRoot = join(configDir, 'workspaces', 'my-workspace')
  mkdirSync(workspaceRoot, { recursive: true })

  writeFileSync(
    join(workspaceRoot, 'config.json'),
    JSON.stringify({
      id: 'ws-config-1',
      name: 'My Workspace',
      slug: 'my-workspace',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, null, 2),
    'utf-8',
  )

  const configPath = join(configDir, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      workspaces: [{ id: 'ws-1', name: 'My Workspace', rootPath: workspaceRoot, createdAt: Date.now() }],
      activeWorkspaceId: 'ws-1',
      activeSessionId: null,
      defaultLlmConnection: llmConnections[0]?.slug ?? null,
      llmConnections,
    }, null, 2),
    'utf-8',
  )

  return { configDir, configPath }
}

function runStorageEval(configDir: string, code: string): string {
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import { deleteLlmConnection, getLlmModelFallbackSettings, setLlmModelFallbackSettings } from '${STORAGE_MODULE_PATH}'; ${code}`,
  ], {
    env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (run.exitCode !== 0) {
    throw new Error(`subprocess failed (exit ${run.exitCode})\nstderr:\n${run.stderr.toString()}`)
  }

  return run.stdout.toString().trim()
}

describe('llm model fallback settings storage', () => {
  it('defaults to disabled with no candidates', () => {
    const { configDir } = setupConfig([makeConnection('primary')])
    const output = runStorageEval(configDir, 'console.log(JSON.stringify(getLlmModelFallbackSettings()))')

    expect(JSON.parse(output)).toEqual({
      enabled: false,
      candidates: [],
    })
  })

  it('persists settings while trimming empty values and duplicate candidates', () => {
    const { configDir, configPath } = setupConfig([
      makeConnection('primary', ['model-a', 'model-b']),
      makeConnection('backup', ['model-c']),
    ])

    const output = runStorageEval(configDir, `
      setLlmModelFallbackSettings({
        enabled: true,
        candidates: [
          { connectionSlug: ' primary ', model: ' model-a ' },
          { connectionSlug: 'primary', model: 'model-a' },
          { connectionSlug: '', model: 'model-b' },
          { connectionSlug: 'backup', model: '' },
          { connectionSlug: 'backup', model: 'model-c' },
        ],
      });
      console.log(JSON.stringify(getLlmModelFallbackSettings()));
    `)

    const expected = {
      enabled: true,
      candidates: [
        { connectionSlug: 'primary', model: 'model-a' },
        { connectionSlug: 'backup', model: 'model-c' },
      ],
    }
    expect(JSON.parse(output)).toEqual(expected)

    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(config.llmModelFallback).toEqual(expected)
  })

  it('removes candidates that reference a deleted connection', () => {
    const { configDir } = setupConfig([
      makeConnection('primary', ['model-a']),
      makeConnection('backup', ['model-b']),
    ])

    const output = runStorageEval(configDir, `
      setLlmModelFallbackSettings({
        enabled: true,
        candidates: [
          { connectionSlug: 'primary', model: 'model-a' },
          { connectionSlug: 'backup', model: 'model-b' },
        ],
      });
      deleteLlmConnection('primary');
      console.log(JSON.stringify(getLlmModelFallbackSettings()));
    `)

    expect(JSON.parse(output)).toEqual({
      enabled: true,
      candidates: [
        { connectionSlug: 'backup', model: 'model-b' },
      ],
    })
  })
})
