# Quickstart: validating the feature

## Prerequisites

* Worktree set up per CONTRIBUTING (pnpm install, WASM nodejs build in `crates/wasm/pkg`).
* No `RESEND_API_KEY` locally: the API logs each link (phase 1) or code (2b) instead of sending
  (FR-016).

## Automated

```sh
pnpm --filter ./packages/api test   # reset, verification, throttle, phase 2 routes
pnpm --filter ./apps/web test       # socialSignInError and other pure helpers
```

The API tests use the fake sender from `test-utils.ts` and follow the recorded link, so they cover
the full round trip without a provider.

## Manual (phase 1)

1. `pnpm dev`. Sign up with a new address. The API log shows a verification link; the profile picker
   shows "Unverified".
2. Open the link in that browser: "Your address is verified"; the badge clears on the next picker
   visit.
3. Sign up a second address, then open its link in a private window: the page asks you to sign in to
   that account and verifies nothing until you do (research D12). Sign in there and the verification
   completes.
4. Sign out. "Forgot password?" with the first address: generic confirmation, reset link in the log.
   Request with an unknown address: the same confirmation, no link.
5. Open the reset link, set a new password. Any other signed-in browser is signed out; the old
   password fails; the new one works.
6. Request a reset four times within the hour for one address: the fourth gets "try again later".
7. Settings on an unverified account: status, the warning, and "Send verification email".

## Production smoke (after deploy)

* Request a reset for your own account; check the email arrives in the inbox within a minute and
  "Show original" reports SPF, DKIM, and DMARC pass.

## Phase 2a

Automated: the Google sign-in tests stub Google's token response, so they cover each case without
Google:

* a Gmail address (no `hd`) and a Workspace account (`hd` present) link into a verified account and
  sign up verified, as before;
* an outside address with `email_verified` true does not link, does not verify, and signs up
  unverified;
* a Workspace account on a secondary domain (`hd` naming another of the organization's domains) also
  links.

Manual, after deploy: sign in with a Gmail account onto its verified VerseVault account; it signs in
as before.

## Phase 2b

Real Google sign-in only works in production. Locally, start the API with placeholder
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to see the redirect to Google, and insert
`pending-google:*` rows into the dev database to drive the picker, with the matching
`better-auth.pending_google` cookie set for `/api/account/google` in the browser (the API tests
cover the callback itself).

1. Sign up: the log shows a code; enter it after sign-up, and the picker badge clears. Enter a wrong
   code three times: "That code has expired. Send a new one."
2. Sign up a second address, then send its code from settings and enter it while signed in to the
   first account: nothing is verified (D12).
3. "Forgot password?": enter the code from the log and a new password, signed in at once; other
   sessions end; the old password fails. Old `/reset-password?token=` and `/verify-email?token=`
   links show the "request a code" page.
4. Picker with a pending row needing a code (an unverified account): enter the code from the
   "connect Google" email; it goes on to the choice. A verification code for the same address does
   not pass. A Google sign-in Google isn't authoritative for onto a verified account is refused with
   the message to sign in with the password and connect Google in settings.
5. "That's me" with the password: Google connected, password kept, verified. "That's not me":
   warning, confirm, then the redirect to Google; the old password fails and sessions are gone.
6. Settings on an unverified account, "Connect Google": comes back asking to verify first. Verified,
   with a different Google address: refused.

Production, after deploy: request a reset code for your own account; check it arrives in the inbox
within a minute and passes SPF, DKIM, and DMARC. Sign in with a non-Gmail Google account onto a
matching account and confirm the code step.

## Phase 2c

* "Reset account": typing the wrong address keeps the button disabled; the right one wipes decks and
  progress, keeps sign-in methods.
