/**
 * useProjects
 *
 * Loads workspace-scoped projects and keeps them in sync via the
 * `projects:changed` broadcast. Mirrors the lightweight half of `useAutomations`.
 */

import { useState, useEffect, useCallback, useLayoutEffect, useRef } from 'react'
import { useSetAtom } from 'jotai'
import { projectsAtom } from '@/atoms/projects'
import type { LoadedProject } from '@craft-agent/shared/projects/types'

export interface UseProjectsResult {
  projects: LoadedProject[]
  refresh: () => Promise<void>
}

export function useProjects(activeWorkspaceId: string | null | undefined): UseProjectsResult {
  const workspaceId = activeWorkspaceId || null
  const [state, setState] = useState<{ workspaceId: string | null; projects: LoadedProject[] }>(() => ({
    workspaceId,
    projects: [],
  }))
  const setProjectsAtom = useSetAtom(projectsAtom)
  const currentWorkspaceIdRef = useRef(workspaceId)
  const requestGenerationRef = useRef(0)
  const isMountedRef = useRef(true)

  // Update this during render so an old request cannot commit in the interval
  // before workspace-switch effects run. The generation also protects A -> B -> A
  // switches, where checking only the workspace id would accept the first A request.
  if (currentWorkspaceIdRef.current !== workspaceId) {
    currentWorkspaceIdRef.current = workspaceId
    requestGenerationRef.current += 1
  }

  const commit = useCallback((
    requestedWorkspaceId: string | null,
    generation: number,
    list: LoadedProject[],
  ) => {
    if (
      !isMountedRef.current
      || currentWorkspaceIdRef.current !== requestedWorkspaceId
      || requestGenerationRef.current !== generation
    ) return
    setState({ workspaceId: requestedWorkspaceId, projects: list })
    setProjectsAtom(list)
  }, [setProjectsAtom])

  const refresh = useCallback(async () => {
    const requestedWorkspaceId = workspaceId
    const generation = ++requestGenerationRef.current
    if (!requestedWorkspaceId) {
      commit(null, generation, [])
      return
    }
    try {
      const result = await window.electronAPI.getProjects(requestedWorkspaceId)
      const list = Array.isArray(result) ? (result as LoadedProject[]) : []
      commit(requestedWorkspaceId, generation, list)
    } catch (err) {
      if (
        currentWorkspaceIdRef.current !== requestedWorkspaceId
        || requestGenerationRef.current !== generation
      ) return
      console.error('[useProjects] Failed to load projects:', err)
      commit(requestedWorkspaceId, generation, [])
    }
  }, [workspaceId, commit])

  // Clear both local and shared state before the switched workspace is painted.
  useLayoutEffect(() => {
    requestGenerationRef.current += 1
    setState({ workspaceId, projects: [] })
    setProjectsAtom([])
  }, [workspaceId, setProjectsAtom])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      // A second consumer (for example TaskEditor) can unmount while its request is
      // still pending. Invalidate it so it cannot overwrite the shared atom later.
      isMountedRef.current = false
      requestGenerationRef.current += 1
    }
  }, [])

  useEffect(() => {
    if (!workspaceId) return
    const off = window.electronAPI.onProjectsChanged((wsId: string, list: unknown) => {
      if (wsId !== workspaceId || currentWorkspaceIdRef.current !== wsId) return
      const projects = Array.isArray(list) ? (list as LoadedProject[]) : []
      const generation = ++requestGenerationRef.current
      commit(wsId, generation, projects)
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [workspaceId, commit])

  return {
    projects: state.workspaceId === workspaceId ? state.projects : [],
    refresh,
  }
}
