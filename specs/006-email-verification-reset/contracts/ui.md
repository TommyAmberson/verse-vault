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
  network", for the per-IP daily limit, which also covers sign-up).
* After a successful sign-up, the form stays up with "Account created. We sent a verification email
  to <address>. You can use the app now; verify when you're ready." and a Continue button.

## Account settings (phase 1)

* Address row shows "Verified" or "Not verified".
* Not verified: a "Send verification email" button, and the warning "Until you verify, anyone with
  access to this inbox can take over this account." (FR-022). Phase 2 adds "or its Google account"
  with the takeover (T025).

## Profile picker (phase 1)

* Each profile with `emailVerified === false` shows an "Unverified" badge (FR-026).

## Google refused (phase 1 interim)

* `account_not_linked`: "This email already has a password account that Google can't join yet. Sign
  in with your password and verify your email in settings, or reset your password, then try Google
  again." It covers both refusals: an unverified local account, and a Google account whose own
  address Google hasn't verified.

## Phase 2

* Profile picker with `?pending=`: "An unverified account with this email already exists. Is it
  yours?" with "That's me" (opens email sign-in for that address, then claims) and "That's not me".
* "That's not me": warning that whoever set the password loses access and the account may hold
  someone else's progress; explicit confirm; then Google sign-in runs again.
* After a takeover: a notice pointing to "Delete all progress" and "Reset account" (FR-023).
* Account settings: "Connect Google" when the account has no Google link; "Reset account" card
  beside "Delete all progress", both through `TypeToConfirmDialog` matching the address.

## Emails

From `VerseVault <no-reply@versevault.ca>`. Plain text plus a minimal HTML part with a button. Each
says why it was sent, gives the link as plain text, states the expiry, and says to ignore it if the
recipient did not ask.

| Email        | Subject                        | Link target                               | Expiry   |
| ------------ | ------------------------------ | ----------------------------------------- | -------- |
| Reset        | Reset your VerseVault password | `<web origin>/reset-password?token=`      | 1 hour   |
| Verification | Verify your VerseVault email   | `<web origin>/verify-email?token=&email=` | 24 hours |
