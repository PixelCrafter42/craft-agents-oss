import { describe, expect, it } from 'bun:test'
import { DEFAULT_MODEL } from '@config/models'
import { selectDefaultTaskModel } from '../task-model-selection'
import type { KanbanModelProviderGroup } from '../types'

describe('selectDefaultTaskModel', () => {
  it('uses the default model when an authenticated connection serves it', () => {
    const groups: KanbanModelProviderGroup[] = [
      { provider: 'anthropic', label: 'Anthropic', models: [{ id: DEFAULT_MODEL, name: 'Opus' }] },
    ]

    expect(selectDefaultTaskModel(groups, new Map([[DEFAULT_MODEL, 'anthropic-api']]))).toBe(DEFAULT_MODEL)
  })

  it('falls back to the first authenticated provider model instead of Opus', () => {
    const groups: KanbanModelProviderGroup[] = [
      { provider: 'openai', label: 'OpenAI', models: [{ id: 'gpt-5.2', name: 'GPT-5.2' }] },
    ]

    expect(selectDefaultTaskModel(groups, new Map([['gpt-5.2', 'openai-api']]))).toBe('gpt-5.2')
  })

  it('skips catalog entries that have no authenticated connection mapping', () => {
    const groups: KanbanModelProviderGroup[] = [
      { provider: 'openai', label: 'OpenAI', models: [{ id: 'stale-model', name: 'Stale' }] },
      { provider: 'xai', label: 'xAI', models: [{ id: 'grok-4', name: 'Grok 4' }] },
    ]

    expect(selectDefaultTaskModel(groups, new Map([['grok-4', 'xai-api']]))).toBe('grok-4')
  })

  it('returns undefined when no authenticated model is available', () => {
    expect(selectDefaultTaskModel([], new Map())).toBeUndefined()
  })
})
