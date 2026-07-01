import type { ErrorCode } from '@craft-agent/core/types'
import type {
  LlmConnection,
  LlmModelFallbackCandidate,
  LlmModelFallbackSettings,
} from '@craft-agent/shared/config'
import { getDefaultModelsForConnection } from '@craft-agent/shared/config'

export interface ResolvedModelFallbackCandidate extends LlmModelFallbackCandidate {
  connection: LlmConnection
}

export interface BuildModelFallbackSequenceInput {
  settings: LlmModelFallbackSettings
  connections: LlmConnection[]
  currentConnectionSlug?: string
  currentModel?: string
  attemptedKeys?: Set<string>
}

export const MODEL_FALLBACK_ELIGIBLE_ERROR_CODES = new Set<ErrorCode>([
  'rate_limited',
  'service_error',
  'service_unavailable',
  'network_error',
  'proxy_error',
  'provider_error',
  'invalid_model',
  'model_no_tool_support',
  'data_policy_error',
  'billing_error',
  'invalid_api_key',
  'invalid_credentials',
  'expired_oauth_token',
])

export function modelFallbackKey(candidate: Pick<LlmModelFallbackCandidate, 'connectionSlug' | 'model'>): string {
  return `${candidate.connectionSlug}\u0000${candidate.model}`
}

function connectionHasModel(connection: LlmConnection, model: string): boolean {
  const availableModels = connection.models?.length
    ? connection.models
    : getDefaultModelsForConnection(connection.providerType, connection.piAuthProvider)
  const modelIds = availableModels
    .map(m => typeof m === 'string' ? m : m.id)
    .filter(Boolean)

  if (modelIds.length > 0) {
    return modelIds.includes(model)
  }

  return connection.defaultModel === model
}

export function isModelFallbackEligibleError(code: ErrorCode | undefined): boolean {
  return !!code && MODEL_FALLBACK_ELIGIBLE_ERROR_CODES.has(code)
}

export function buildModelFallbackSequence(input: BuildModelFallbackSequenceInput): ResolvedModelFallbackCandidate[] {
  if (!input.settings.enabled || input.settings.candidates.length === 0) return []

  const connectionsBySlug = new Map(input.connections.map(connection => [connection.slug, connection]))
  const seen = new Set<string>()
  const resolved: ResolvedModelFallbackCandidate[] = []

  for (const candidate of input.settings.candidates) {
    const connectionSlug = candidate.connectionSlug.trim()
    const model = candidate.model.trim()
    if (!connectionSlug || !model) continue

    const key = modelFallbackKey({ connectionSlug, model })
    if (seen.has(key)) continue
    seen.add(key)

    const connection = connectionsBySlug.get(connectionSlug)
    if (!connection) continue
    if (!connectionHasModel(connection, model)) continue

    resolved.push({ connectionSlug, model, connection })
  }

  if (resolved.length === 0) return []

  const currentKey = input.currentConnectionSlug && input.currentModel
    ? modelFallbackKey({ connectionSlug: input.currentConnectionSlug, model: input.currentModel })
    : null
  const currentIndex = currentKey
    ? resolved.findIndex(candidate => modelFallbackKey(candidate) === currentKey)
    : -1
  const ordered = currentIndex >= 0
    ? resolved.slice(currentIndex + 1)
    : resolved

  if (!input.attemptedKeys?.size) return ordered
  return ordered.filter(candidate => !input.attemptedKeys!.has(modelFallbackKey(candidate)))
}
