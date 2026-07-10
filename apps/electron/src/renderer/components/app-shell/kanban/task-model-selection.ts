import { DEFAULT_MODEL } from '@config/models'
import type { KanbanModelProviderGroup } from './types'

/** Pick a model that is actually served by an authenticated workspace connection. */
export function selectDefaultTaskModel(
  groups: KanbanModelProviderGroup[],
  modelToConnection: ReadonlyMap<string, string>,
): string | undefined {
  if (modelToConnection.has(DEFAULT_MODEL)) return DEFAULT_MODEL
  for (const group of groups) {
    for (const model of group.models) {
      if (modelToConnection.has(model.id)) return model.id
    }
  }
  return undefined
}
