/**
 * Employee Storage
 *
 * CRUD operations for workspace-scoped employee identities.
 * File structure:
 * {workspaceRootPath}/employees/{employeeSlug}/
 *   ├── config.json
 *   ├── EMPLOYEE.md
 *   └── MEMORY.md
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'path';
import { randomUUID } from 'crypto';
import { atomicWriteFileSync, readJsonFileSync } from '../utils/files.ts';
import { debug } from '../utils/debug.ts';
import { estimateTokensDensityAware } from '../utils/large-response.ts';
import type {
  CreateEmployeeInput,
  EmployeeConfig,
  LoadedEmployee,
} from './types.ts';

export const EMPLOYEE_DEFINITION_FILENAME = 'EMPLOYEE.md';
export const EMPLOYEE_MEMORY_FILENAME = 'MEMORY.md';
export const EMPLOYEE_AVATAR_FILENAME = 'avatar.png';
export const MAX_EMPLOYEE_AVATAR_BYTES = 512 * 1024;

export function getWorkspaceEmployeesPath(workspaceRootPath: string): string {
  return join(workspaceRootPath, 'employees');
}

/**
 * Employee slugs are storage directory names, not arbitrary paths.
 * Keep this in sync with generateEmployeeSlug().
 */
export function isValidEmployeeSlug(employeeSlug: unknown): employeeSlug is string {
  return typeof employeeSlug === 'string'
    && employeeSlug.length <= 64
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(employeeSlug);
}

export function assertValidEmployeeSlug(employeeSlug: unknown): asserts employeeSlug is string {
  if (!isValidEmployeeSlug(employeeSlug)) {
    throw new Error('Invalid employee slug');
  }
}

export function getEmployeePath(workspaceRootPath: string, employeeSlug: string): string {
  assertValidEmployeeSlug(employeeSlug);

  const employeesRoot = resolve(getWorkspaceEmployeesPath(workspaceRootPath));
  const employeePath = resolve(employeesRoot, employeeSlug);
  const relativePath = relative(employeesRoot, employeePath);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Employee path escapes employees directory: ${employeeSlug}`);
  }
  return employeePath;
}

export function getEmployeeDefinitionPath(workspaceRootPath: string, employeeSlug: string): string {
  return join(getEmployeePath(workspaceRootPath, employeeSlug), EMPLOYEE_DEFINITION_FILENAME);
}

export function getEmployeeMemoryPath(workspaceRootPath: string, employeeSlug: string): string {
  return join(getEmployeePath(workspaceRootPath, employeeSlug), EMPLOYEE_MEMORY_FILENAME);
}

export function getEmployeeAvatarPath(workspaceRootPath: string, employeeSlug: string): string {
  return join(getEmployeePath(workspaceRootPath, employeeSlug), EMPLOYEE_AVATAR_FILENAME);
}

export function ensureEmployeesDir(workspaceRootPath: string): void {
  const dir = getWorkspaceEmployeesPath(workspaceRootPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function loadEmployeeConfig(
  workspaceRootPath: string,
  employeeSlug: string,
): EmployeeConfig | null {
  const configPath = join(getEmployeePath(workspaceRootPath, employeeSlug), 'config.json');
  if (!existsSync(configPath)) return null;

  try {
    const config = readJsonFileSync<EmployeeConfig>(configPath);
    if (!isValidEmployeeSlug(config.slug) || config.slug !== employeeSlug) {
      debug('[loadEmployeeConfig] Config slug does not match its storage directory:', employeeSlug);
      return null;
    }
    return config;
  } catch (error) {
    debug('[loadEmployeeConfig] Failed to read employee config:', employeeSlug, error);
    return null;
  }
}

export function saveEmployeeConfig(workspaceRootPath: string, config: EmployeeConfig): void {
  const dir = getEmployeePath(workspaceRootPath, config.slug);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const storageConfig: EmployeeConfig = {
    ...config,
    skillSlugs: normalizeStringList(config.skillSlugs),
    enabledSourceSlugs: normalizeStringList(config.enabledSourceSlugs),
    updatedAt: Date.now(),
  };

  atomicWriteFileSync(join(dir, 'config.json'), JSON.stringify(storageConfig, null, 2));
}

export function loadEmployeeDefinition(
  workspaceRootPath: string,
  employeeSlug: string,
  maxTokens = 5000,
): string | null {
  return loadCappedMarkdown(getEmployeeDefinitionPath(workspaceRootPath, employeeSlug), maxTokens);
}

export function loadEmployeeMemory(
  workspaceRootPath: string,
  employeeSlug: string,
  maxTokens = 5000,
): string | null {
  return loadCappedMarkdown(getEmployeeMemoryPath(workspaceRootPath, employeeSlug), maxTokens);
}

export function loadEmployee(
  workspaceRootPath: string,
  employeeSlug: string,
): LoadedEmployee | null {
  const config = loadEmployeeConfig(workspaceRootPath, employeeSlug);
  if (!config) return null;

  return buildLoadedEmployee(workspaceRootPath, config);
}

export function loadEmployeeById(
  workspaceRootPath: string,
  employeeId: string,
): LoadedEmployee | null {
  const employees = loadWorkspaceEmployees(workspaceRootPath);
  return employees.find((employee) => employee.config.id === employeeId) ?? null;
}

export function loadWorkspaceEmployees(workspaceRootPath: string): LoadedEmployee[] {
  ensureEmployeesDir(workspaceRootPath);

  const employees: LoadedEmployee[] = [];
  const employeesDir = getWorkspaceEmployeesPath(workspaceRootPath);
  if (!existsSync(employeesDir)) return employees;

  for (const entry of readdirSync(employeesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!isValidEmployeeSlug(entry.name)) continue;
    const employee = loadEmployee(workspaceRootPath, entry.name);
    if (employee) employees.push(employee);
  }

  employees.sort((a, b) => a.config.name.localeCompare(b.config.name));
  return employees;
}

export function generateEmployeeSlug(workspaceRootPath: string, name: string): string {
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);

  if (!slug) slug = 'employee';

  const employeesDir = getWorkspaceEmployeesPath(workspaceRootPath);
  const existingSlugs = new Set<string>();
  if (existsSync(employeesDir)) {
    for (const entry of readdirSync(employeesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) existingSlugs.add(entry.name);
    }
  }

  if (!existingSlugs.has(slug)) return slug;

  let counter = 2;
  while (existingSlugs.has(`${slug}-${counter}`)) counter++;
  return `${slug}-${counter}`;
}

export function createEmployee(
  workspaceRootPath: string,
  input: CreateEmployeeInput,
): EmployeeConfig {
  const slug = generateEmployeeSlug(workspaceRootPath, input.name);
  const now = Date.now();

  const config: EmployeeConfig = {
    id: `emp_${randomUUID().slice(0, 8)}`,
    slug,
    name: input.name,
    description: input.description,
    color: input.color,
    skillSlugs: normalizeStringList(input.skillSlugs),
    enabledSourceSlugs: normalizeStringList(input.enabledSourceSlugs),
    createdAt: now,
    updatedAt: now,
  };

  saveEmployeeConfig(workspaceRootPath, config);
  const definition = input.definition ?? defaultEmployeeDefinition(input.name, input.description);
  writeFileSync(getEmployeeDefinitionPath(workspaceRootPath, slug), definition, 'utf-8');
  if (!existsSync(getEmployeeMemoryPath(workspaceRootPath, slug))) {
    writeFileSync(getEmployeeMemoryPath(workspaceRootPath, slug), '# Memory\n\n', 'utf-8');
  }

  return config;
}

export function updateEmployee(
  workspaceRootPath: string,
  employeeSlug: string,
  patch: Partial<Omit<EmployeeConfig, 'id' | 'slug' | 'createdAt'>>,
): EmployeeConfig {
  const existing = loadEmployeeConfig(workspaceRootPath, employeeSlug);
  if (!existing) {
    throw new Error(`Employee not found: ${employeeSlug}`);
  }

  const updated: EmployeeConfig = {
    ...existing,
    ...patch,
    id: existing.id,
    slug: existing.slug,
    createdAt: existing.createdAt,
    skillSlugs: normalizeStringList(patch.skillSlugs ?? existing.skillSlugs),
    enabledSourceSlugs: normalizeStringList(patch.enabledSourceSlugs ?? existing.enabledSourceSlugs),
    updatedAt: Date.now(),
  };

  saveEmployeeConfig(workspaceRootPath, updated);
  return updated;
}

export function updateEmployeeDefinition(
  workspaceRootPath: string,
  employeeSlug: string,
  content: string,
): void {
  if (!employeeExists(workspaceRootPath, employeeSlug)) {
    throw new Error(`Employee not found: ${employeeSlug}`);
  }
  writeFileSync(getEmployeeDefinitionPath(workspaceRootPath, employeeSlug), content, 'utf-8');
}

export function updateEmployeeMemory(
  workspaceRootPath: string,
  employeeSlug: string,
  content: string,
): void {
  if (!employeeExists(workspaceRootPath, employeeSlug)) {
    throw new Error(`Employee not found: ${employeeSlug}`);
  }
  writeFileSync(getEmployeeMemoryPath(workspaceRootPath, employeeSlug), content, 'utf-8');
}

/** Persist a server-normalized PNG avatar in the employee directory. */
export function updateEmployeeAvatar(
  workspaceRootPath: string,
  employeeSlug: string,
  content: Uint8Array,
): void {
  if (!employeeExists(workspaceRootPath, employeeSlug)) {
    throw new Error(`Employee not found: ${employeeSlug}`);
  }
  if (content.byteLength === 0 || content.byteLength > MAX_EMPLOYEE_AVATAR_BYTES) {
    throw new Error('Employee avatar must be between 1 byte and 512 KiB');
  }

  const avatarPath = getEmployeeAvatarPath(workspaceRootPath, employeeSlug);
  const tempPath = `${avatarPath}.tmp`;
  try {
    writeFileSync(tempPath, content);
    renameSync(tempPath, avatarPath);
  } catch (error) {
    try { unlinkSync(tempPath); } catch {}
    throw error;
  }
}

export function deleteEmployeeAvatar(workspaceRootPath: string, employeeSlug: string): void {
  if (!employeeExists(workspaceRootPath, employeeSlug)) {
    throw new Error(`Employee not found: ${employeeSlug}`);
  }
  const avatarPath = getEmployeeAvatarPath(workspaceRootPath, employeeSlug);
  if (existsSync(avatarPath)) unlinkSync(avatarPath);
}

export function deleteEmployee(workspaceRootPath: string, employeeSlug: string): void {
  const dir = getEmployeePath(workspaceRootPath, employeeSlug);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true });
  }
}

export function employeeExists(workspaceRootPath: string, employeeSlug: string): boolean {
  return existsSync(join(getEmployeePath(workspaceRootPath, employeeSlug), 'config.json'));
}

function loadCappedMarkdown(filePath: string, maxTokens: number): string | null {
  if (!existsSync(filePath)) return null;

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (error) {
    debug('[loadCappedMarkdown] Failed to read markdown:', filePath, error);
    return null;
  }

  if (!content.trim()) return null;

  const tokens = estimateTokensDensityAware(content);
  if (tokens <= maxTokens) return content;

  const marker = `\n\n...[truncated at ${maxTokens}-token cap - keep this employee file shorter]`;
  const markerTokens = estimateTokensDensityAware(marker);
  const bodyBudget = Math.max(0, maxTokens - markerTokens);
  const charsPerToken = content.length / tokens;
  const charBudget = Math.floor(bodyBudget * charsPerToken);
  const head = content.slice(0, charBudget).trimEnd();
  return `${head}${marker}`;
}

function buildLoadedEmployee(workspaceRootPath: string, config: EmployeeConfig): LoadedEmployee {
  return {
    config,
    folderPath: getEmployeePath(workspaceRootPath, config.slug),
    definitionPath: getEmployeeDefinitionPath(workspaceRootPath, config.slug),
    memoryPath: getEmployeeMemoryPath(workspaceRootPath, config.slug),
    workspaceRootPath,
    workspaceId: basename(workspaceRootPath),
    definition: loadEmployeeDefinition(workspaceRootPath, config.slug) ?? undefined,
    memoryContent: loadEmployeeMemory(workspaceRootPath, config.slug) ?? undefined,
    avatarDataUrl: loadEmployeeAvatarDataUrl(workspaceRootPath, config.slug),
  };
}

function loadEmployeeAvatarDataUrl(workspaceRootPath: string, employeeSlug: string): string | undefined {
  const avatarPath = getEmployeeAvatarPath(workspaceRootPath, employeeSlug);
  if (!existsSync(avatarPath)) return undefined;
  try {
    return `data:image/png;base64,${readFileSync(avatarPath).toString('base64')}`;
  } catch (error) {
    debug('[loadEmployeeAvatarDataUrl] Failed to read employee avatar:', employeeSlug, error);
    return undefined;
  }
}

function normalizeStringList(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const unique = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
  return unique.length > 0 ? unique : undefined;
}

function defaultEmployeeDefinition(name: string, description?: string): string {
  return `# ${name}\n\n## Identity\n\n${description?.trim() || 'Describe this employee role.'}\n\n## Responsibilities\n\n- Add what this employee is responsible for.\n\n## Out of Scope\n\n- Add what this employee should not do.\n\n## Output\n\n- Keep responses concise and actionable.\n`;
}
