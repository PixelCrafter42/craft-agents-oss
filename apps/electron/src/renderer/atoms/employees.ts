import { atom } from 'jotai'
import type { LoadedEmployee } from '@craft-agent/shared/employees/types'

export const employeesAtom = atom<LoadedEmployee[]>([])
