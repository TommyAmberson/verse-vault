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

export const VERIFY_SENT = 'If that address still needs verifying, a new link is on its way.'

/** The address a verification link is for, read from its token's payload.
 *  Only used to pick which profile to sign in as: the server checks the
 *  token's signature and the session itself. */
export function verificationTokenEmail(token: string): string | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const email = (JSON.parse(json) as { email?: unknown }).email
    return typeof email === 'string' ? email : null
  } catch {
    return null
  }
}
