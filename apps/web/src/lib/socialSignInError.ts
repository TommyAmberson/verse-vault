/** Better Auth's OAuth callback reports a failed social sign-in by sending the
 *  browser back to `errorCallbackURL` with `?error=<code>`. */
export interface SocialSignInError {
  message: string
  /** The address already belongs to an email and password account, so the
   *  form should open on email sign-in. */
  passwordAccount: boolean
}

/** Google sign-in refuses to merge into a password account unless both the
 *  account's email and Google's are verified. The learner can fix the first
 *  by signing in and verifying, or by resetting the password. */
const ACCOUNT_NOT_LINKED = 'account_not_linked'

export function socialSignInError(search: string): SocialSignInError | null {
  const code = new URLSearchParams(search).get('error')
  if (!code) return null
  if (code === ACCOUNT_NOT_LINKED) {
    return {
      message:
        "This email already has a password account that Google can't join yet. Sign in with your " +
        'password and verify your email in settings, or reset your password, then try Google again.',
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
