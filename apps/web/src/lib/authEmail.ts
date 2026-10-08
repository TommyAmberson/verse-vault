/** What the learner sees after asking for a reset or verification email. */

type EmailRequestResult = { error?: { status?: number } | null } | undefined

export const THROTTLED_MESSAGE = 'Too many requests for this address. Try again later.'

/** The server answers every address the same way, so an error here is
 *  throttling or a real failure, never "no such account", and saying so
 *  reveals nothing. */
export function emailRequestMessage(result: EmailRequestResult, sent: string): string {
  if (!result?.error) return sent
  if (result.error.status === 429) return THROTTLED_MESSAGE
  return 'Something went wrong. Try again.'
}

export const RESET_SENT = 'If an account exists for that address, a reset email is on its way.'
