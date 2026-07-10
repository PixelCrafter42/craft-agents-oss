import { useState, useEffect, useCallback, useLayoutEffect, useRef } from 'react'
import { useSetAtom } from 'jotai'
import { employeesAtom } from '@/atoms/employees'
import type { LoadedEmployee } from '@craft-agent/shared/employees/types'

export interface UseEmployeesResult {
  employees: LoadedEmployee[]
  refresh: () => Promise<void>
}

export function useEmployees(activeWorkspaceId: string | null | undefined): UseEmployeesResult {
  const workspaceId = activeWorkspaceId || null
  const [state, setState] = useState<{ workspaceId: string | null; employees: LoadedEmployee[] }>(() => ({
    workspaceId,
    employees: [],
  }))
  const setEmployeesAtom = useSetAtom(employeesAtom)
  const currentWorkspaceIdRef = useRef(workspaceId)
  const requestGenerationRef = useRef(0)
  const isMountedRef = useRef(true)

  if (currentWorkspaceIdRef.current !== workspaceId) {
    currentWorkspaceIdRef.current = workspaceId
    requestGenerationRef.current += 1
  }

  const commit = useCallback((
    requestedWorkspaceId: string | null,
    generation: number,
    list: LoadedEmployee[],
  ) => {
    if (
      !isMountedRef.current
      || currentWorkspaceIdRef.current !== requestedWorkspaceId
      || requestGenerationRef.current !== generation
    ) return
    setState({ workspaceId: requestedWorkspaceId, employees: list })
    setEmployeesAtom(list)
  }, [setEmployeesAtom])

  const refresh = useCallback(async () => {
    const requestedWorkspaceId = workspaceId
    const generation = ++requestGenerationRef.current
    if (!requestedWorkspaceId) {
      commit(null, generation, [])
      return
    }
    try {
      const result = await window.electronAPI.getEmployees(requestedWorkspaceId)
      const list = Array.isArray(result) ? (result as LoadedEmployee[]) : []
      commit(requestedWorkspaceId, generation, list)
    } catch (err) {
      if (
        currentWorkspaceIdRef.current !== requestedWorkspaceId
        || requestGenerationRef.current !== generation
      ) return
      console.error('[useEmployees] Failed to load employees:', err)
      commit(requestedWorkspaceId, generation, [])
    }
  }, [workspaceId, commit])

  useLayoutEffect(() => {
    requestGenerationRef.current += 1
    setState({ workspaceId, employees: [] })
    setEmployeesAtom([])
  }, [workspaceId, setEmployeesAtom])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      requestGenerationRef.current += 1
    }
  }, [])

  useEffect(() => {
    if (!workspaceId) return
    const off = window.electronAPI.onEmployeesChanged((wsId: string, list: unknown) => {
      if (wsId !== workspaceId || currentWorkspaceIdRef.current !== wsId) return
      const employees = Array.isArray(list) ? (list as LoadedEmployee[]) : []
      const generation = ++requestGenerationRef.current
      commit(wsId, generation, employees)
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [workspaceId, commit])

  return {
    employees: state.workspaceId === workspaceId ? state.employees : [],
    refresh,
  }
}
