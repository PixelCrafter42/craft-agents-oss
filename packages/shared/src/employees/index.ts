/**
 * Employees Module
 *
 * Public exports for workspace-scoped employee identities.
 */

export type {
  EmployeeConfig,
  CreateEmployeeInput,
  LoadedEmployee,
  EmployeePromptContext,
} from './types.ts';

export {
  EMPLOYEE_DEFINITION_FILENAME,
  EMPLOYEE_MEMORY_FILENAME,
  EMPLOYEE_AVATAR_FILENAME,
  MAX_EMPLOYEE_AVATAR_BYTES,
  ensureEmployeesDir,
  getWorkspaceEmployeesPath,
  getEmployeePath,
  getEmployeeDefinitionPath,
  getEmployeeMemoryPath,
  getEmployeeAvatarPath,
  isValidEmployeeSlug,
  assertValidEmployeeSlug,
  loadEmployeeConfig,
  saveEmployeeConfig,
  loadEmployeeDefinition,
  loadEmployeeMemory,
  loadEmployee,
  loadEmployeeById,
  loadWorkspaceEmployees,
  generateEmployeeSlug,
  createEmployee,
  updateEmployee,
  updateEmployeeDefinition,
  updateEmployeeMemory,
  updateEmployeeAvatar,
  deleteEmployeeAvatar,
  deleteEmployee,
  employeeExists,
} from './storage.ts';
