export function shouldUsePersistedContextTokenFallback(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return isMissingContextTokenErrorMessage(message) || isRecoverableNativeSendErrorMessage(message)
}

export function isExpiredContextTokenError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /(?:ret|errcode)=-14(?:\D|$)/i.test(message)
}

export function describeWeixinSendResponseError(response: {
  ret?: number
  errcode?: number
  errmsg?: string
}): string | undefined {
  const retFailed = response.ret !== undefined && response.ret !== 0
  const errcodeFailed = response.errcode !== undefined && response.errcode !== 0
  if (!retFailed && !errcodeFailed) return undefined
  return `sendMessage ret=${response.ret ?? '(none)'} errcode=${response.errcode ?? '(none)'} errmsg=${response.errmsg ?? '(none)'}`
}

export function isMissingContextTokenErrorMessage(message: string): boolean {
  return /没有找到 context_token|contextToken missing|context_token is required/i.test(message)
}

function isRecoverableNativeSendErrorMessage(message: string): boolean {
  return /sendMessage ret=-2(?:\D|$)/i.test(message)
}
