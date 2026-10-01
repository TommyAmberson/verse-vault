/** Better Auth's OAuth callback reports a failed social sign-in by sending the
 *  browser back to `errorCallbackURL` with `?error=<code>`. */
export interface SocialSignInError {
  message: string
  /** The address already belongs to an email and password account, so the
   *  form should open on email sign-in. */
  passwordAccount: boolean
}

/** Since better-auth 1.6.11, Google sign-in refuses to merge into a password
 *  account whose email is unverified, and ours never are. */
const ACCOUNT_NOT_LINKED = 'account_not_linked'

export function socialSignInError(search: string): SocialSignInError | null {
  const code = new URLSearchParams(search).get('error')
  if (!code) return null
  if (code === ACCOUNT_NOT_LINKED) {
    return {
      message:
        'This email already has a password account. Sign in with your email and password instead.',
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
