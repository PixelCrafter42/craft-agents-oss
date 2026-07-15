import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createEmployee,
  deleteEmployeeAvatar,
  deleteEmployee,
  getEmployeePath,
  isValidEmployeeSlug,
  loadEmployeeConfig,
  loadEmployeeById,
  loadWorkspaceEmployees,
  updateEmployeeAvatar,
  updateEmployeeMemory,
} from '../storage.ts';
import {
  createSession,
  loadSession,
  setSessionEmployeeId,
  unbindEmployeeFromSessions,
} from '../../sessions/storage.ts';

let tempDir: string;
let workspaceRoot: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'employees-test-'));
  workspaceRoot = join(tempDir, 'workspace');
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('employee storage', () => {
  it('rejects traversal and non-canonical directory names at every employee path entry', () => {
    mkdirSync(workspaceRoot, { recursive: true });
    const sentinel = join(workspaceRoot, 'config.json');
    writeFileSync(sentinel, '{"workspace":"safe"}');

    for (const slug of ['..', '../outside', 'valid/../../outside', '/tmp/outside', '.', '', 'Uppercase', 'a--b']) {
      expect(isValidEmployeeSlug(slug)).toBe(false);
      expect(() => getEmployeePath(workspaceRoot, slug)).toThrow('Invalid employee slug');
      expect(() => loadEmployeeConfig(workspaceRoot, slug)).toThrow('Invalid employee slug');
      expect(() => deleteEmployee(workspaceRoot, slug)).toThrow('Invalid employee slug');
    }

    expect(existsSync(workspaceRoot)).toBe(true);
    expect(existsSync(sentinel)).toBe(true);
  });

  it('creates a workspace employee with definition, memory, skills, and sources', () => {
    const employee = createEmployee(workspaceRoot, {
      name: 'Status Manager',
      description: 'Tracks user status updates.',
      skillSlugs: [' status ', 'status', ''],
      enabledSourceSlugs: ['dida', 'dida', 'rss'],
      definition: '# Status Manager\n\nKeep status records tidy.',
    });

    expect(employee.slug).toBe('status-manager');
    expect(employee.name).toBe('Status Manager');
    expect(employee.skillSlugs).toEqual(['status']);
    expect(employee.enabledSourceSlugs).toEqual(['dida', 'rss']);

    updateEmployeeMemory(workspaceRoot, employee.slug, '# Memory\n\n- Prefer short status summaries.\n');

    const loaded = loadEmployeeById(workspaceRoot, employee.id);
    expect(loaded?.definition).toContain('Keep status records tidy.');
    expect(loaded?.memoryContent).toContain('Prefer short status summaries.');

    const all = loadWorkspaceEmployees(workspaceRoot);
    expect(all.map(e => e.config.id)).toContain(employee.id);
  });

  it('persists session employee binding and can unbind sessions when an employee is deleted', async () => {
    const employee = createEmployee(workspaceRoot, { name: 'Dida Manager' });
    const session = await createSession(workspaceRoot, { name: 'task', employeeId: employee.id });

    expect(loadSession(workspaceRoot, session.id)?.employeeId).toBe(employee.id);

    await setSessionEmployeeId(workspaceRoot, session.id, null);
    expect(loadSession(workspaceRoot, session.id)?.employeeId).toBeUndefined();

    await setSessionEmployeeId(workspaceRoot, session.id, employee.id);
    const touched = await unbindEmployeeFromSessions(workspaceRoot, employee.id);
    deleteEmployee(workspaceRoot, employee.slug);

    expect(touched).toBe(1);
    expect(loadSession(workspaceRoot, session.id)?.employeeId).toBeUndefined();
    expect(loadEmployeeById(workspaceRoot, employee.id)).toBeNull();
  });

  it('stores a normalized employee avatar outside config and removes it independently', () => {
    const employee = createEmployee(workspaceRoot, { name: 'Designer' });
    const normalizedPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    updateEmployeeAvatar(workspaceRoot, employee.slug, normalizedPng);

    expect(loadEmployeeById(workspaceRoot, employee.id)?.avatarDataUrl)
      .toBe(`data:image/png;base64,${Buffer.from(normalizedPng).toString('base64')}`);
    expect(loadEmployeeConfig(workspaceRoot, employee.slug)).not.toHaveProperty('avatarDataUrl');

    deleteEmployeeAvatar(workspaceRoot, employee.slug);
    expect(loadEmployeeById(workspaceRoot, employee.id)?.avatarDataUrl).toBeUndefined();
  });

  it('rejects empty or unexpectedly large normalized avatars', () => {
    const employee = createEmployee(workspaceRoot, { name: 'Designer' });

    expect(() => updateEmployeeAvatar(workspaceRoot, employee.slug, new Uint8Array()))
      .toThrow('between 1 byte and 512 KiB');
    expect(() => updateEmployeeAvatar(workspaceRoot, employee.slug, new Uint8Array(512 * 1024 + 1)))
      .toThrow('between 1 byte and 512 KiB');
  });
});
