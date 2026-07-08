/**
 * Prompt automation session reuse state.
 *
 * Stores stable matcherId -> sessionId mappings outside the append-only
 * execution history, so reuse survives restarts and history compaction.
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'path';
import { AUTOMATIONS_SESSION_STATE_FILE } from './constants.ts';

export interface AutomationSessionStateEntry {
  sessionId: string;
  updatedAt: number;
}

export interface AutomationSessionState {
  version: 1;
  sessions: Record<string, AutomationSessionStateEntry>;
}

const mutexes = new Map<string, Promise<void>>();

function emptyState(): AutomationSessionState {
  return { version: 1, sessions: {} };
}

function statePath(workspaceRootPath: string): string {
  return join(workspaceRootPath, AUTOMATIONS_SESSION_STATE_FILE);
}

function withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = mutexes.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  mutexes.set(key, next.then(() => {}, () => {}));
  return next;
}

function normalizeState(raw: unknown): AutomationSessionState {
  if (!raw || typeof raw !== 'object') return emptyState();
  const data = raw as { sessions?: unknown };
  if (!data.sessions || typeof data.sessions !== 'object') return emptyState();

  const sessions: Record<string, AutomationSessionStateEntry> = {};
  for (const [matcherId, entry] of Object.entries(data.sessions as Record<string, unknown>)) {
    if (!matcherId || !entry || typeof entry !== 'object') continue;
    const maybe = entry as { sessionId?: unknown; updatedAt?: unknown };
    if (typeof maybe.sessionId !== 'string' || maybe.sessionId.length === 0) continue;
    sessions[matcherId] = {
      sessionId: maybe.sessionId,
      updatedAt: typeof maybe.updatedAt === 'number' ? maybe.updatedAt : 0,
    };
  }

  return { version: 1, sessions };
}

export async function loadAutomationSessionState(workspaceRootPath: string): Promise<AutomationSessionState> {
  const filePath = statePath(workspaceRootPath);
  if (!existsSync(filePath)) return emptyState();

  try {
    return normalizeState(JSON.parse(await readFile(filePath, 'utf-8')));
  } catch {
    return emptyState();
  }
}

async function saveAutomationSessionState(
  workspaceRootPath: string,
  state: AutomationSessionState,
): Promise<void> {
  await writeFile(statePath(workspaceRootPath), JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

export async function getReusableAutomationSessionId(
  workspaceRootPath: string,
  matcherId: string,
): Promise<string | undefined> {
  const state = await loadAutomationSessionState(workspaceRootPath);
  return state.sessions[matcherId]?.sessionId;
}

export async function setReusableAutomationSessionId(
  workspaceRootPath: string,
  matcherId: string,
  sessionId: string,
): Promise<void> {
  await withMutex(workspaceRootPath, async () => {
    const state = await loadAutomationSessionState(workspaceRootPath);
    state.sessions[matcherId] = { sessionId, updatedAt: Date.now() };
    await saveAutomationSessionState(workspaceRootPath, state);
  });
}

export async function clearReusableAutomationSessionId(
  workspaceRootPath: string,
  matcherId: string,
): Promise<void> {
  await withMutex(workspaceRootPath, async () => {
    const state = await loadAutomationSessionState(workspaceRootPath);
    if (!(matcherId in state.sessions)) return;
    delete state.sessions[matcherId];
    await saveAutomationSessionState(workspaceRootPath, state);
  });
}
