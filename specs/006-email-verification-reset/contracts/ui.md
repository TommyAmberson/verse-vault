# UI Contract

## Pages (public routes, phase 1)

| Route                                        | Shows                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/reset-password?token=`                     | new-password form under the sign-up rules; on success, "Password changed" with a sign-in action                                                                                                                                                                                                          |
| `/reset-password`, token rejected            | "This link is no longer valid" with a field to request a new one (FR-011)                                                                                                                                                                                                                                |
| `/verify-email?token=&email=`                | if signed in to the token's account: verifies and shows "Your address is verified"; if another profile is active: offers to switch to that account; if signed out: "Sign in to finish verifying" with email sign-in prefilled, then verifies. Never verifies without that session (FR-008, research D12) |
| `/verify-email`, link rejected or incomplete | "This link is no longer valid" with a way to request a new one (FR-011)                                                                                                                                                                                                                                  |

## Sign-in form (phase 1)

* Email sign-in mode gains "Forgot password?", opening a mode with one address field.
* After submit, always: "If an account exists for that address, a reset email is on its way."
* 429: the server's message, "Too many requests for this address. Try again later." (or "from this
  network", for the per-IP daily limit).
* After a successful sign-up, the form stays up with "Account created. Check <address> for a
  verification email. You can use the app now; verify when you're ready. If none arrives, send
  another from account settings." and a Continue button. Past the network's daily limit, sign-up
  sends no email, so the note doesn't promise one.

## Account settings (phase 1)

* Address row shows "Verified" or "Not verified".
* Not verified: a "Send verification email" button, and the warning "Until you verify, anyone with
  access to this inbox can take over this account." (FR-022). Phase 2 adds "or its Google account"
  with the takeover (T025).

## Profile picker (phase 1)

* Each profile with `emailVerified === false` shows an "Unverified" badge (FR-026).

## Google refused

* Phase 1, `account_not_linked`: "This email already has a password account that Google can't join
  yet. Sign in with your password and verify your email in settings, or reset your password, then
  try Google again."
* Phase 2a, `account_not_linked` (any refusal onto an existing account: an unverified account, or
  Google not being authoritative for the address): "This email already has a VerseVault account that
  Google can't sign in to yet. Sign in with your password instead, or reset it."
* Phase 2b, when only Google never having verified the address remains: "Google hasn't verified this
  email address, so it can't sign in to the account that uses it. Sign in with your password
  instead, or reset it."

## Codes (phase 2b)

One code field everywhere: 6 digits, numeric keyboard on mobile, `autocomplete="one-time-code"`,
with "Send a new code" beside it and "Only the code in the newest email works." under it. A wrong
code: "That code isn't right." Expired, used, or three wrong tries: "That code has expired. Send a
new one." (FR-011).

* Sign-in form, "Forgot password?": the address, then "If an account exists for that address, we
  sent it a code", then the code and a new password in the same form. On success the learner is
  signed in with the new password.
* After sign-up: "Account created. Enter the code we sent to <address> to verify it, or skip and
  verify later from account settings." with the code field and a Continue button. Past the network's
  daily limit no code is sent, and the note says to send one from settings.
* Account settings, unverified: "Send verification code", then the code field. Verified on success.
* `/reset-password` and `/verify-email` (links from emails sent before 2b): "Emails now carry a code
  instead of a link." with a way to request one (reset form, or settings for verification).

## Phase 2b: Google

* Picker with `?pending=1&email=&code=1`: "To connect Google, enter the code we sent to <address>."
  with the code field; with `&sent=0`, it says no code could be sent because too many were asked for
  the address, and to sign in with Google again in about 20 minutes. The pending token is a cookie
  the page never sees. A verified account then signs in with Google; an unverified one goes on to
  the choice below. A learner who can't enter the code sees nothing more about the account.
* Picker with `?pending=1&email=` (Google authoritative, or code confirmed): "An unverified account
  for <address> already exists. Is it yours?" with "That's me" (opens email sign-in for that
  address, then claims) and "That's not me".
* "That's not me": warning that whoever set the password loses access and the account may hold
  someone else's progress; explicit confirm; then Google sign-in runs again with `callbackURL` set
  to the picker with `?taken-over=1`.
* After a takeover: the picker reads `?taken-over=1` once, removes it from the URL, and shows a
  notice pointing to "Delete all progress" and "Reset account" in settings (FR-023). The flag only
  shows text and grants nothing, so a hand-typed one is harmless.
* Account settings: "Connect Google" when the account has no Google link. Coming back with
  `?error=verify_email_first`: "Verify your email address first, then connect Google." next to the
  verification code controls. A different Google address: "That Google account uses a different
  email address."

## Phase 2c

* Account settings: "Reset account" card beside "Delete all progress", both through
  `TypeToConfirmDialog` matching the address, sharing one dialog.

## Emails

From `VerseVault <no-reply@versevault.ca>`. Plain text plus a minimal HTML part. Each says why it
was sent and what to do if the recipient did not ask.

| Email                  | Subject                                         | Carries                                                                                         | Expiry     |
| ---------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------- |
| Reset (phase 1)        | Reset your VerseVault password                  | link to `<web origin>/reset-password?token=`                                                    | 1 hour     |
| Verification (phase 1) | Verify your VerseVault email                    | link to `<web origin>/verify-email?token=&email=`                                               | 24 hours   |
| Reset (2b)             | Your VerseVault reset code                      | the code, prominent; "Don't share it with anyone"                                               | 10 minutes |
| Verification (2b)      | Your VerseVault code                            | the code, prominent; the same warning                                                           |            |
| Google code step (2b)  | Your VerseVault code to connect Google          | the code; says a Google account is being connected, and to enter it only if the reader did that |            |
| Google connected (2b)  | Google was connected to your VerseVault account | no code; if this wasn't the reader, reset the password                                          | 10 minutes |

The Google code step sends the verification email; it says the code confirms the address.
