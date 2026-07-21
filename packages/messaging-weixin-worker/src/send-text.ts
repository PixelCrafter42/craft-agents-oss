import {
  isExpiredContextTokenError,
  shouldUsePersistedContextTokenFallback,
} from './send-error'

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
  tokenlessSend?: () => Promise<string>,
): Promise<SendTextWithFallbackResult> {
  try {
    await nativeSend()
    return { usedFallback: false }
  } catch (error) {
    if (tokenlessSend && isExpiredContextTokenError(error)) {
      return { usedFallback: true, messageId: await tokenlessSend() }
    }
    if (!shouldUsePersistedContextTokenFallback(error)) throw error
  }

  try {
    return {
      usedFallback: true,
      messageId: await persistedSend(),
    }
  } catch (error) {
    if (!tokenlessSend || !isExpiredContextTokenError(error)) throw error
    return { usedFallback: true, messageId: await tokenlessSend() }
  }
}
