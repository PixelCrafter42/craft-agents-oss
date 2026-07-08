import { useState, useEffect, useCallback } from 'react'
import { useSetAtom } from 'jotai'
import { employeesAtom } from '@/atoms/employees'
import type { LoadedEmployee } from '@craft-agent/shared/employees/types'

export interface UseEmployeesResult {
  employees: LoadedEmployee[]
  refresh: () => Promise<void>
}

export function useEmployees(activeWorkspaceId: string | null | undefined): UseEmployeesResult {
  const [employees, setEmployees] = useState<LoadedEmployee[]>([])
  const setEmployeesAtom = useSetAtom(employeesAtom)

  const refresh = useCallback(async () => {
    if (!activeWorkspaceId) {
      setEmployees([])
      setEmployeesAtom([])
      return
    }
    try {
      const result = await window.electronAPI.getEmployees(activeWorkspaceId)
      const list = Array.isArray(result) ? (result as LoadedEmployee[]) : []
      setEmployees(list)
      setEmployeesAtom(list)
    } catch (err) {
      console.error('[useEmployees] Failed to load employees:', err)
      setEmployees([])
      setEmployeesAtom([])
    }
  }, [activeWorkspaceId, setEmployeesAtom])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    if (!activeWorkspaceId) return
    const off = window.electronAPI.onEmployeesChanged((wsId: string, list: unknown) => {
      if (wsId !== activeWorkspaceId) return
      const employees = Array.isArray(list) ? (list as LoadedEmployee[]) : []
      setEmployees(employees)
      setEmployeesAtom(employees)
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [activeWorkspaceId, setEmployeesAtom])

  return { employees, refresh }
}
