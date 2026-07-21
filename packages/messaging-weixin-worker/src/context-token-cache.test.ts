import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  contextTokenCachePath,
  contextTokenKey,
  deleteContextToken,
  loadContextToken,
  saveContextToken,
} from './context-token-cache'

const cleanups: Array<() => void> = []

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wx-context-cache-test-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('Weixin context token cache', () => {
  it('persists and reloads a token by account and user', () => {
    const stateDir = makeTmpDir()

    saveContextToken(stateDir, 'Acct-1', 'user-1', ' token-a ')

    expect(loadContextToken(stateDir, 'acct-1', 'user-1')).toBe('token-a')
    expect(existsSync(contextTokenCachePath(stateDir))).toBe(true)
  })

  it('overwrites the latest token for the same account and user', () => {
    const stateDir = makeTmpDir()

    saveContextToken(stateDir, 'acct-1', 'user-1', 'token-a')
    saveContextToken(stateDir, 'acct-1', 'user-1', 'token-b')

    expect(loadContextToken(stateDir, 'acct-1', 'user-1')).toBe('token-b')
  })

  it('does not return a token for another user', () => {
    const stateDir = makeTmpDir()

    saveContextToken(stateDir, 'acct-1', 'user-1', 'token-a')

    expect(loadContextToken(stateDir, 'acct-1', 'user-2')).toBeUndefined()
  })

  it('deletes only the stale token for the requested account and user', () => {
    const stateDir = makeTmpDir()

    saveContextToken(stateDir, 'acct-1', 'user-1', 'token-a')
    saveContextToken(stateDir, 'acct-1', 'user-2', 'token-b')

    expect(deleteContextToken(stateDir, 'acct-1', 'user-1')).toBe(true)
    expect(deleteContextToken(stateDir, 'acct-1', 'user-1')).toBe(false)
    expect(loadContextToken(stateDir, 'acct-1', 'user-1')).toBeUndefined()
    expect(loadContextToken(stateDir, 'acct-1', 'user-2')).toBe('token-b')
  })

  it('stores the cache under the OpenClaw state dir with private permissions', () => {
    const stateDir = makeTmpDir()

    saveContextToken(stateDir, 'acct-1', 'user-1', 'token-a')

    expect(contextTokenCachePath(stateDir)).toBe(join(stateDir, 'openclaw-weixin', 'context-tokens.json'))
    if (process.platform !== 'win32') {
      expect(statSync(contextTokenCachePath(stateDir)).mode & 0o777).toBe(0o600)
    }
  })

  it('normalizes account ids in cache keys', () => {
    expect(contextTokenKey('Acct-1', 'user-1')).toBe('acct-1:user-1')
  })
})
