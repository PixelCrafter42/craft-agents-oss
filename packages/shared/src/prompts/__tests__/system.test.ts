import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Stub the preferences module so we can toggle `getCoAuthorPreference` per test
// without touching disk. `formatPreferencesForPrompt` is stubbed to '' because
// it's unrelated to the behavior under test here.
let mockIncludeCoAuthoredBy = true
mock.module('../../config/preferences.ts', () => ({
  getCoAuthorPreference: () => mockIncludeCoAuthoredBy,
  formatPreferencesForPrompt: () => '',
}))

import {
  getProjectContextFilesPrompt,
  getSystemPrompt,
  invalidateContextFileCache,
} from '../system'

const GIT_CONVENTIONS_HEADING = '## Git Conventions'
const CO_AUTHOR_TRAILER = 'Co-Authored-By: Craft Agent <agents-noreply@craft.do>'

let tempDirs: string[] = []

function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'craft-system-prompt-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs) {
    invalidateContextFileCache(dir)
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

describe('system prompt guidance', () => {
  it('uses backend-neutral debug log querying guidance (rg/grep via Bash)', () => {
    const prompt = getSystemPrompt(
      undefined,
      { enabled: true, logFilePath: '/tmp/main.log' },
      '/tmp/workspace',
      '/tmp/workspace'
    )

    expect(prompt).toContain('Use Bash with `rg`/`grep` to search logs efficiently:')
    expect(prompt).toContain('rg -n "session" "/tmp/main.log"')
    expect(prompt).not.toContain('Use the Grep tool (if available)')
    expect(prompt).not.toContain('Grep pattern=')
  })

  it('does not mention Grep in call_llm tool-dependency guidance', () => {
    const prompt = getSystemPrompt(undefined, undefined, '/tmp/workspace', '/tmp/workspace')

    expect(prompt).toContain('The subtask needs file/shell tools (for example, Read or Bash)')
    expect(prompt).not.toContain('The subtask needs tools (Read, Bash, Grep)')
  })
})

describe('project context file prompt', () => {
  it('loads root agents.md content into the generated system prompt', () => {
    const projectDir = makeTempProject()
    writeFileSync(join(projectDir, 'agents.md'), 'ROOT AGENTS SENTINEL')

    const prompt = getSystemPrompt(
      undefined,
      undefined,
      '/tmp/workspace',
      projectDir,
      undefined,
      undefined,
      false
    )

    expect(prompt).toContain('<project_context_files')
    expect(prompt).toContain('- agents.md (root, loaded below)')
    expect(prompt).toContain('<loaded_project_context_file path="agents.md" scope="root">')
    expect(prompt).toContain('ROOT AGENTS SENTINEL')
  })

  it('loads root AGENTS.md case-insensitively', () => {
    const projectDir = makeTempProject()
    writeFileSync(join(projectDir, 'AGENTS.md'), 'UPPERCASE AGENTS SENTINEL')

    const prompt = getProjectContextFilesPrompt(projectDir)

    expect(prompt).toContain('- AGENTS.md (root, loaded below)')
    expect(prompt).toContain('<loaded_project_context_file path="AGENTS.md" scope="root">')
    expect(prompt).toContain('UPPERCASE AGENTS SENTINEL')
  })

  it('prefers agents.md over CLAUDE.md when both root files exist', () => {
    const projectDir = makeTempProject()
    writeFileSync(join(projectDir, 'CLAUDE.md'), 'CLAUDE ROOT SENTINEL')
    writeFileSync(join(projectDir, 'agents.md'), 'AGENTS ROOT SENTINEL')

    const prompt = getProjectContextFilesPrompt(projectDir)

    expect(prompt).toContain('<loaded_project_context_file path="agents.md" scope="root">')
    expect(prompt).toContain('AGENTS ROOT SENTINEL')
    expect(prompt).not.toContain('CLAUDE ROOT SENTINEL')
  })

  it('lists nested context files without loading their content', () => {
    const projectDir = makeTempProject()
    writeFileSync(join(projectDir, 'agents.md'), 'ROOT AGENTS SENTINEL')
    mkdirSync(join(projectDir, 'packages', 'app'), { recursive: true })
    writeFileSync(join(projectDir, 'packages', 'app', 'AGENTS.md'), 'NESTED AGENTS SENTINEL')

    const prompt = getProjectContextFilesPrompt(projectDir)

    expect(prompt).toContain('- agents.md (root, loaded below)')
    expect(prompt).toContain('- packages/app/AGENTS.md')
    expect(prompt).toContain('ROOT AGENTS SENTINEL')
    expect(prompt).not.toContain('NESTED AGENTS SENTINEL')
  })

  it('does not emit a project context block without a working directory', () => {
    const prompt = getProjectContextFilesPrompt(undefined)

    expect(prompt).toBe('')
  })
})

describe('includeCoAuthoredBy handling', () => {
  beforeEach(() => {
    mockIncludeCoAuthoredBy = true
  })

  it('includes the Git Conventions block when the arg is explicitly true', () => {
    const prompt = getSystemPrompt(
      undefined,
      undefined,
      '/tmp/workspace',
      '/tmp/workspace',
      undefined,
      undefined,
      true
    )

    expect(prompt).toContain(GIT_CONVENTIONS_HEADING)
    expect(prompt).toContain(CO_AUTHOR_TRAILER)
  })

  it('omits the Git Conventions block when the arg is explicitly false', () => {
    const prompt = getSystemPrompt(
      undefined,
      undefined,
      '/tmp/workspace',
      '/tmp/workspace',
      undefined,
      undefined,
      false
    )

    expect(prompt).not.toContain(GIT_CONVENTIONS_HEADING)
    expect(prompt).not.toContain(CO_AUTHOR_TRAILER)
  })

  // Regression test for #576: Pi-backed sessions called getSystemPrompt without
  // the 7th arg, and the function silently defaulted to `true`, ignoring the
  // user's preference. The defensive fallback in getSystemPrompt should now
  // resolve to getCoAuthorPreference() when the arg is omitted.
  it('falls back to getCoAuthorPreference() when the arg is omitted (#576)', () => {
    mockIncludeCoAuthoredBy = false

    const prompt = getSystemPrompt(
      undefined,
      undefined,
      '/tmp/workspace',
      '/tmp/workspace',
      undefined,
      'Craft Agents Backend'
      // 7th arg omitted — must not regress to `true` default
    )

    expect(prompt).not.toContain(GIT_CONVENTIONS_HEADING)
    expect(prompt).not.toContain(CO_AUTHOR_TRAILER)
  })

  it('falls back to getCoAuthorPreference() === true when the arg is omitted and the user has not opted out', () => {
    mockIncludeCoAuthoredBy = true

    const prompt = getSystemPrompt(
      undefined,
      undefined,
      '/tmp/workspace',
      '/tmp/workspace'
    )

    expect(prompt).toContain(GIT_CONVENTIONS_HEADING)
    expect(prompt).toContain(CO_AUTHOR_TRAILER)
  })
})
