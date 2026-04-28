/**
 * Build the weixin-agent-sdk-backed Weixin worker into a self-contained CJS
 * file at packages/messaging-weixin-worker/dist/worker.cjs.
 */

import { spawn } from 'bun'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as esbuild from 'esbuild'

function resolveGitSha(cwd: string): string {
  try {
    const sha = execSync('git rev-parse --short HEAD', { cwd }).toString().trim()
    let dirty = false
    try {
      dirty = execSync('git status --porcelain', { cwd }).toString().trim().length > 0
    } catch {
      // best effort
    }
    return dirty ? `${sha}+dirty` : sha
  } catch {
    return 'unknown'
  }
}

const ROOT_DIR = join(import.meta.dir, '..')
const WORKER_DIR = join(ROOT_DIR, 'packages/messaging-weixin-worker')
const SOURCE = join(WORKER_DIR, 'src/worker.ts')
const DIST_DIR = join(WORKER_DIR, 'dist')
const OUTPUT = join(DIST_DIR, 'worker.cjs')

async function verifyJsFile(filePath: string): Promise<{ valid: boolean; error?: string }> {
  if (!existsSync(filePath)) return { valid: false, error: 'File does not exist' }
  if (statSync(filePath).size === 0) return { valid: false, error: 'File is empty' }
  const proc = spawn({
    cmd: ['node', '--check', filePath],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  return exitCode === 0 ? { valid: true } : { valid: false, error: stderr || 'Syntax error' }
}

async function main(): Promise<void> {
  if (!existsSync(SOURCE)) {
    console.error('Weixin worker source not found at', SOURCE)
    process.exit(1)
  }
  mkdirSync(DIST_DIR, { recursive: true })

  const buildId = new Date().toISOString()
  const gitSha = resolveGitSha(ROOT_DIR)
  console.log(`Building Weixin worker - build ${buildId} (${gitSha})...`)

  try {
    await esbuild.build({
      entryPoints: [SOURCE],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      outfile: OUTPUT,
      define: {
        __WEIXIN_WORKER_BUILD_ID__: JSON.stringify(buildId),
        __WEIXIN_WORKER_GIT_SHA__: JSON.stringify(gitSha),
      },
      logLevel: 'info',
    })
  } catch (err) {
    console.error('Weixin worker build failed:', err)
    process.exit(1)
  }

  const verification = await verifyJsFile(OUTPUT)
  if (!verification.valid) {
    console.error('Weixin worker verification failed:', verification.error)
    process.exit(1)
  }

  const { size } = statSync(OUTPUT)
  console.log(`Weixin worker built (${(size / 1024 / 1024).toFixed(2)} MB) -> ${OUTPUT}`)
}

main().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
