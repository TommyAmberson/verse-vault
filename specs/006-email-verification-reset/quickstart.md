# Quickstart: validating the feature

## Prerequisites

* Worktree set up per CONTRIBUTING (pnpm install, WASM nodejs build in `crates/wasm/pkg`).
* No `RESEND_API_KEY` locally: the API logs each link instead of sending (FR-016).

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

## Phase 2

1. Unverified password account A. Signed out, sign in with Google using A's address: the choice
   appears. "That's me" with the password: Google connected, password still works, verified.
2. Repeat with account B and "That's not me": warning, confirm, Google sign-in completes; B's old
   password fails and its other sessions are gone.
3. Signed in with a password, "Connect Google" with a different Google address: refused.
4. "Reset account": typing the wrong address keeps the button disabled; the right one wipes decks
   and progress, keeps sign-in methods.
