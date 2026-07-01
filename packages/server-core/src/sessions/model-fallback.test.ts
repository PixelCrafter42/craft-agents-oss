import { describe, expect, it } from 'bun:test'
import { getDefaultModelForConnection, type LlmConnection } from '@craft-agent/shared/config'
import {
  buildModelFallbackSequence,
  isModelFallbackEligibleError,
  modelFallbackKey,
} from './model-fallback'

function connection(overrides: Partial<LlmConnection>): LlmConnection {
  return {
    slug: 'anthropic',
    name: 'Anthropic',
    providerType: 'anthropic',
    authType: 'api_key',
    createdAt: 1,
    models: ['claude-opus', 'claude-sonnet'],
    defaultModel: 'claude-sonnet',
    ...overrides,
  }
}

describe('model fallback resolver', () => {
  const anthropic = connection({})
  const copilot = connection({
    slug: 'copilot',
    name: 'Copilot',
    providerType: 'pi',
    models: ['gpt-5', 'gpt-5-mini'],
    defaultModel: 'gpt-5',
  })

  it('starts after the current connection/model when it is present in the list', () => {
    const sequence = buildModelFallbackSequence({
      settings: {
        enabled: true,
        candidates: [
          { connectionSlug: 'anthropic', model: 'claude-opus' },
          { connectionSlug: 'anthropic', model: 'claude-sonnet' },
          { connectionSlug: 'copilot', model: 'gpt-5' },
        ],
      },
      connections: [anthropic, copilot],
      currentConnectionSlug: 'anthropic',
      currentModel: 'claude-sonnet',
    })

    expect(sequence.map(c => [c.connectionSlug, c.model])).toEqual([
      ['copilot', 'gpt-5'],
    ])
  })

  it('starts from the first valid candidate when the current model is not listed', () => {
    const sequence = buildModelFallbackSequence({
      settings: {
        enabled: true,
        candidates: [
          { connectionSlug: 'anthropic', model: 'claude-opus' },
          { connectionSlug: 'copilot', model: 'gpt-5' },
        ],
      },
      connections: [anthropic, copilot],
      currentConnectionSlug: 'anthropic',
      currentModel: 'claude-haiku',
    })

    expect(sequence.map(c => [c.connectionSlug, c.model])).toEqual([
      ['anthropic', 'claude-opus'],
      ['copilot', 'gpt-5'],
    ])
  })

  it('skips duplicate, missing, unavailable, and already-attempted candidates', () => {
    const sequence = buildModelFallbackSequence({
      settings: {
        enabled: true,
        candidates: [
          { connectionSlug: 'missing', model: 'missing-model' },
          { connectionSlug: 'anthropic', model: 'unknown-model' },
          { connectionSlug: 'anthropic', model: 'claude-opus' },
          { connectionSlug: 'anthropic', model: 'claude-opus' },
          { connectionSlug: 'copilot', model: 'gpt-5' },
        ],
      },
      connections: [anthropic, copilot],
      attemptedKeys: new Set([modelFallbackKey({ connectionSlug: 'anthropic', model: 'claude-opus' })]),
    })

    expect(sequence.map(c => [c.connectionSlug, c.model])).toEqual([
      ['copilot', 'gpt-5'],
    ])
  })

  it('uses provider registry models when the connection has no persisted models array', () => {
    const registryModel = getDefaultModelForConnection('anthropic')
    const sequence = buildModelFallbackSequence({
      settings: {
        enabled: true,
        candidates: [
          { connectionSlug: 'anthropic', model: registryModel },
        ],
      },
      connections: [
        connection({
          models: undefined,
          defaultModel: undefined,
        }),
      ],
    })

    expect(sequence.map(c => [c.connectionSlug, c.model])).toEqual([
      ['anthropic', registryModel],
    ])
  })

  it('recognizes model-recoverable errors and rejects request/user/runtime errors', () => {
    expect(isModelFallbackEligibleError('rate_limited')).toBe(true)
    expect(isModelFallbackEligibleError('network_error')).toBe(true)
    expect(isModelFallbackEligibleError('expired_oauth_token')).toBe(true)
    expect(isModelFallbackEligibleError('billing_error')).toBe(true)

    expect(isModelFallbackEligibleError('invalid_request')).toBe(false)
    expect(isModelFallbackEligibleError('image_too_large')).toBe(false)
    expect(isModelFallbackEligibleError('queued_message_replay_failed')).toBe(false)
    expect(isModelFallbackEligibleError('sdk_binary_missing')).toBe(false)
    expect(isModelFallbackEligibleError('sdk_cwd_missing')).toBe(false)
  })
})
