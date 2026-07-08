import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTOMATIONS_SESSION_STATE_FILE } from './constants.ts';
import {
  clearReusableAutomationSessionId,
  getReusableAutomationSessionId,
  loadAutomationSessionState,
  setReusableAutomationSessionId,
} from './reuse-state.ts';

describe('reuse-state', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'automation-reuse-state-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('stores and reads matcher session mappings', async () => {
    await setReusableAutomationSessionId(tempDir, 'abc123', 'sess-one');

    expect(await getReusableAutomationSessionId(tempDir, 'abc123')).toBe('sess-one');

    const raw = JSON.parse(readFileSync(join(tempDir, AUTOMATIONS_SESSION_STATE_FILE), 'utf-8'));
    expect(raw.version).toBe(1);
    expect(raw.sessions.abc123.sessionId).toBe('sess-one');
    expect(typeof raw.sessions.abc123.updatedAt).toBe('number');
  });

  it('clears a mapping without removing the state file', async () => {
    await setReusableAutomationSessionId(tempDir, 'abc123', 'sess-one');
    await clearReusableAutomationSessionId(tempDir, 'abc123');

    expect(existsSync(join(tempDir, AUTOMATIONS_SESSION_STATE_FILE))).toBe(true);
    expect(await getReusableAutomationSessionId(tempDir, 'abc123')).toBeUndefined();
  });

  it('treats invalid state JSON as empty', async () => {
    writeFileSync(join(tempDir, AUTOMATIONS_SESSION_STATE_FILE), '{bad json', 'utf-8');

    expect(await loadAutomationSessionState(tempDir)).toEqual({ version: 1, sessions: {} });
  });
});
