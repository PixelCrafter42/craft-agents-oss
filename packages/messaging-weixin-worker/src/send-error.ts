export function shouldUsePersistedContextTokenFallback(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return isMissingContextTokenErrorMessage(message) || isRecoverableNativeSendErrorMessage(message)
}

export function isMissingContextTokenErrorMessage(message: string): boolean {
  return /没有找到 context_token|contextToken missing|context_token is required/i.test(message)
}

function isRecoverableNativeSendErrorMessage(message: string): boolean {
  return /sendMessage ret=-2(?:\D|$)/i.test(message)
}
