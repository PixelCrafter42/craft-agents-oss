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
  ensureEmployeesDir,
  getWorkspaceEmployeesPath,
  getEmployeePath,
  getEmployeeDefinitionPath,
  getEmployeeMemoryPath,
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
  deleteEmployee,
  employeeExists,
} from './storage.ts';
