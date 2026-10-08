/** What the learner sees after asking for a reset or verification email. */

export type EmailRequestResult =
  | { error?: { status?: number; message?: string | null } | null }
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

export const RESET_SENT = 'If an account exists for that address, a reset email is on its way.'

export const VERIFY_SENT = 'If that address still needs verifying, a new link is on its way.'
