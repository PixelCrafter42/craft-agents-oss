import { shouldUsePersistedContextTokenFallback } from './send-error'

export type SendTextWithFallbackResult =
  | { usedFallback: false }
  | { usedFallback: true; messageId: string }

/**
 * Prefer the SDK's active-session send path. The persisted context token is
 * only a recovery path for the SDK's specific missing-context error.
 */
export async function sendTextWithPersistedFallback(
  nativeSend: () => Promise<void>,
  persistedSend: () => Promise<string>,
): Promise<SendTextWithFallbackResult> {
  try {
    await nativeSend()
    return { usedFallback: false }
  } catch (error) {
    if (!shouldUsePersistedContextTokenFallback(error)) throw error
  }

  return {
    usedFallback: true,
    messageId: await persistedSend(),
  }
}
