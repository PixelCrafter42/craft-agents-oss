import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const CACHE_VERSION = 1

interface ContextTokenRecord {
  accountId: string
  userId: string
  token: string
  updatedAt: string
}

interface ContextTokenCache {
  version: typeof CACHE_VERSION
  tokens: Record<string, ContextTokenRecord>
}

function weixinStateDir(stateDir: string): string {
  return path.join(stateDir, 'openclaw-weixin')
}

export function contextTokenCachePath(stateDir: string): string {
  return path.join(weixinStateDir(stateDir), 'context-tokens.json')
}

export function contextTokenKey(accountId: string, userId: string): string {
  return `${accountId.trim().toLowerCase()}:${userId.trim()}`
}

function emptyCache(): ContextTokenCache {
  return { version: CACHE_VERSION, tokens: {} }
}

function loadCache(stateDir: string): ContextTokenCache {
  try {
    const file = contextTokenCachePath(stateDir)
    if (!existsSync(file)) return emptyCache()
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<ContextTokenCache>
    if (parsed.version !== CACHE_VERSION || !parsed.tokens || typeof parsed.tokens !== 'object') {
      return emptyCache()
    }
    return { version: CACHE_VERSION, tokens: parsed.tokens }
  } catch {
    return emptyCache()
  }
}

function saveCache(stateDir: string, cache: ContextTokenCache): void {
  const file = contextTokenCachePath(stateDir)
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf-8')
  try {
    process.platform !== 'win32' && chmodSync(tmp, 0o600)
  } catch {
    // best effort
  }
  renameSync(tmp, file)
}

export function saveContextToken(
  stateDir: string,
  accountId: string,
  userId: string,
  token: string,
): void {
  const normalizedToken = token.trim()
  const normalizedUserId = userId.trim()
  const normalizedAccountId = accountId.trim().toLowerCase()
  if (!normalizedToken || !normalizedUserId || !normalizedAccountId) return

  const cache = loadCache(stateDir)
  cache.tokens[contextTokenKey(normalizedAccountId, normalizedUserId)] = {
    accountId: normalizedAccountId,
    userId: normalizedUserId,
    token: normalizedToken,
    updatedAt: new Date().toISOString(),
  }
  saveCache(stateDir, cache)
}

export function loadContextToken(
  stateDir: string,
  accountId: string,
  userId: string,
): string | undefined {
  const record = loadCache(stateDir).tokens[contextTokenKey(accountId, userId)]
  const token = record?.token?.trim()
  return token || undefined
}
