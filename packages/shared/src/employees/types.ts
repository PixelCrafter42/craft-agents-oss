/**
 * Employee Types
 *
 * Employees are workspace-scoped reusable agent identities. They define a role,
 * default skills/sources, and optional long-lived memory. Sessions may bind to
 * zero or one employee.
 */

export interface EmployeeConfig {
  id: string;
  slug: string;
  name: string;
  description?: string;
  color?: string;
  /** Skills automatically active when a bound session sends a message. */
  skillSlugs?: string[];
  /** Sources automatically available when a bound session sends a message. */
  enabledSourceSlugs?: string[];
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

export interface CreateEmployeeInput {
  name: string;
  description?: string;
  color?: string;
  skillSlugs?: string[];
  enabledSourceSlugs?: string[];
  definition?: string;
}

export interface LoadedEmployee {
  config: EmployeeConfig;
  folderPath: string;
  definitionPath: string;
  memoryPath: string;
  workspaceRootPath: string;
  workspaceId: string;
  definition?: string;
  memoryContent?: string;
}

export interface EmployeePromptContext {
  name: string;
  description?: string;
  definitionPath: string;
  definition?: string;
  memoryPath: string;
  memoryContent?: string;
  skillSlugs?: string[];
  enabledSourceSlugs?: string[];
}
