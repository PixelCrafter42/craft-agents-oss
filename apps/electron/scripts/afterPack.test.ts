import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const afterPack = require('./afterPack.cjs') as ((context: {
  electronPlatformName: string
  appOutDir: string
  packager: { projectDir: string }
}) => Promise<void>) & { _execFileSync: (file: string, args: string[]) => void }

const originalPath = process.env.PATH
const originalDevRuntime = process.env.CRAFT_DEV_RUNTIME
const originalExecFileSync = afterPack._execFileSync
const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'after-pack-test-'))
  roots.push(root)
  return root
}

afterEach(() => {
  process.env.PATH = originalPath
  if (originalDevRuntime === undefined) delete process.env.CRAFT_DEV_RUNTIME
  else process.env.CRAFT_DEV_RUNTIME = originalDevRuntime
  afterPack._execFileSync = originalExecFileSync
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('afterPack Liquid Glass icon', () => {
  it('compiles icon.icon into the packaged Resources directory', async () => {
    const root = tempRoot()
    const projectDir = join(root, 'project')
    const appOutDir = join(root, 'out')
    mkdirSync(join(projectDir, 'resources', 'icon.icon'), { recursive: true })
    afterPack._execFileSync = (file, args) => {
      expect(file).toBe('xcrun')
      expect(args[0]).toBe('actool')
      expect(args[1]?.endsWith('AppIcon.icon')).toBe(true)
      expect(existsSync(args[1]!)).toBe(true)
      expect(args).toContain('--include-all-app-icons')
      expect(args).toContain('--target-device')
      expect(args[args.indexOf('--app-icon') + 1]).toBe('AppIcon')
      const compileIndex = args.indexOf('--compile')
      const outputDir = args[compileIndex + 1]
      if (!outputDir) throw new Error('missing compile output')
      mkdirSync(outputDir, { recursive: true })
      writeFileSync(join(outputDir, 'Assets.car'), 'compiled')
    }
    delete process.env.CRAFT_DEV_RUNTIME

    await afterPack({ electronPlatformName: 'darwin', appOutDir, packager: { projectDir } })

    expect(existsSync(join(appOutDir, 'Craft Agents.app', 'Contents', 'Resources', 'Assets.car'))).toBe(true)
  })

  it('fails release packaging instead of silently omitting Assets.car', async () => {
    const root = tempRoot()
    const projectDir = join(root, 'project')
    const appOutDir = join(root, 'out')
    mkdirSync(join(projectDir, 'resources', 'icon.icon'), { recursive: true })
    afterPack._execFileSync = () => { throw new Error('actool unavailable') }
    delete process.env.CRAFT_DEV_RUNTIME

    await expect(afterPack({ electronPlatformName: 'darwin', appOutDir, packager: { projectDir } }))
      .rejects.toThrow('Liquid Glass icon build failed')
  })
})
