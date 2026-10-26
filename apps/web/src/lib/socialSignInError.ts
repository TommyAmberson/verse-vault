import type { LocationQuery } from 'vue-router'

/** Better Auth's OAuth callback reports a failed social sign-in or link by
 *  sending the browser back to `errorCallbackURL` with `?error=<code>`. */
export interface SocialSignInError {
  /** Better Auth's code, or one the API sets, such as `verify_email_first`. */
  code: string
  message: string
  /** The address already belongs to an email and password account, so the
   *  form should open on email sign-in. */
  passwordAccount: boolean
}

/** A Google sign-in onto an existing account is refused unless Google is
 *  authoritative for the address (Gmail, or a Workspace account); an
 *  unverified account then gets the choice on the picker instead. Until
 *  Google can join, the password or a reset gets the learner in. */
const ACCOUNT_NOT_LINKED = 'account_not_linked'

export function socialSignInError(search: string): SocialSignInError | null {
  const code = new URLSearchParams(search).get('error')
  if (!code) return null
  if (code === ACCOUNT_NOT_LINKED) {
    return {
      message:
        "This email already has a VerseVault account that Google can't sign in to yet. Sign in " +
        'with your password instead, or reset it.',
      passwordAccount: true,
      code,
    }
  }
  const message = LINK_ERRORS[code] ?? 'Google sign-in failed. Please try again.'
  return { message, passwordAccount: false, code }
}

/** Codes from connecting Google to a signed-in account (`linkSocial`). */
const LINK_ERRORS: Record<string, string> = {
  "email_doesn't_match": 'That Google account uses a different email address.',
  account_already_linked_to_different_user:
    'That Google account is already connected to a different account.',
  // Google doesn't speak for this address, and the account hasn't proven
  // the inbox yet (research D17).
  verify_email_first: 'Verify your email address with a code first, then connect Google.',
}

/** `query` without `keys`, for dropping one-shot parameters through the
 *  router once they're read. */
export function queryWithout(query: LocationQuery, ...keys: string[]): LocationQuery {
  return Object.fromEntries(Object.entries(query).filter(([key]) => !keys.includes(key)))
}

/** `href` without the `error` query parameter, so a reload or a later
 *  sign-in doesn't show the same message again. */
export function withoutErrorParam(href: string): string {
  const url = new URL(href)
  url.searchParams.delete('error')
  url.searchParams.delete('error_description')
  return url.toString()
}
