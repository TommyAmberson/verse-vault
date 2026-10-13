/** Better Auth's OAuth callback reports a failed social sign-in by sending the
 *  browser back to `errorCallbackURL` with `?error=<code>`. */
export interface SocialSignInError {
  message: string
  /** The address already belongs to an email and password account, so the
   *  form should open on email sign-in. */
  passwordAccount: boolean
}

/** A Google sign-in onto an existing account is refused unless the account
 *  is verified and Google is authoritative for the address (Gmail, or a
 *  Workspace account). Until Google can join, the password
 *  or a reset gets the learner in. */
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
    }
  }
  return { message: 'Google sign-in failed. Please try again.', passwordAccount: false }
}

/** `href` without the `error` query parameter, so a reload or a later
 *  sign-in doesn't show the same message again. */
export function withoutErrorParam(href: string): string {
  const url = new URL(href)
  url.searchParams.delete('error')
  url.searchParams.delete('error_description')
  return url.toString()
}
