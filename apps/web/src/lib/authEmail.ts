/** What the learner sees after asking for a code, or entering one. */

export type EmailRequestResult =
  | { error?: { status?: number; code?: string; message?: string | null } | null }
  | undefined

/** The server answers every address the same way, so an error here is
 *  throttling or a real failure, never "no such account", and saying so
 *  reveals nothing. A throttled request shows the server's own message. */
export function emailRequestMessage(result: EmailRequestResult, sent: string): string {
  if (!result?.error) return sent
  if (result.error.status === 429) {
    return result.error.message || 'Too many requests for this address. Try again later.'
  }
  return 'Something went wrong. Try again.'
}

export const RESET_SENT = 'If an account exists for that address, we sent it a code.'

/** The refusals that are about the code itself, as opposed to the request. */
export const CODE_FAILURES = new Set(['INVALID_OTP', 'OTP_EXPIRED', 'TOO_MANY_ATTEMPTS'])

/** Why a code the learner entered was refused, or null when it worked. A
 *  used code reads as wrong: the server keeps no record of it. */
export function codeErrorMessage(result: EmailRequestResult): string | null {
  const error = result?.error
  if (!error) return null
  if (error.code === 'INVALID_OTP') return "That code isn't right."
  if (error.code === 'OTP_EXPIRED' || error.code === 'TOO_MANY_ATTEMPTS') {
    return 'That code has expired. Send a new one.'
  }
  if (error.status === 429) return error.message || 'Too many tries. Try again later.'
  // A too-short password on reset, or verifying from another account's
  // session; the server says which.
  return error.message || 'Something went wrong. Try again.'
}
