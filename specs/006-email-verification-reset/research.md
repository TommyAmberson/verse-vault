# Research: Email Verification and Password Reset

Findings come from better-auth 1.6.33 as installed (`packages/api/node_modules/better-auth`, which
resolves to `node_modules/.pnpm/better-auth@1.6.33*/node_modules/better-auth/dist`, cited below as
`BA/`) and from the verse-vault code at the point this feature branched (master 271afd0).

## D1. Sending email

**Decision**: a small sender in `packages/api/src/lib/email.ts` that POSTs to the Resend HTTPS API
with `fetch`, following the `ApibibleCache` pattern: an injectable `fetch` for tests, the API key
optional in the environment, and the feature degrading when it is missing. With no key it logs the
link it would have sent (FR-016). The sender never throws to its caller: a failed send is logged
with the provider's status and a truncated body, never the link (FR-015).

**Rationale**: one HTTPS call needs no SDK (Principle VII). Never throwing matters for privacy:
`POST /send-verification-email` re-throws a sender error (BA/api/routes/email-verification.mjs:116),
which would tell a caller that the address has an account.

**Alternatives considered**: the `resend` npm package (a dependency for one call); SMTP (blocked on
DigitalOcean droplets, see issue #171).

## D2. Not awaiting the send

**Decision**: the Better Auth callbacks (`sendResetPassword`, `sendVerificationEmail`) start the
send with `void` and return at once. No `advanced.backgroundTasks` handler.

**Rationale**: Better Auth awaits `sendResetPassword` for a real user but does fake work for an
unknown address (BA/api/routes/password.mjs:60-82), so an awaited network call would make real
accounts measurably slower (FR-002, SC-003). `/send-verification-email` awaits its sender directly
with a 500 ms floor (email-verification.mjs:31, 96-118), and `backgroundTasks` does not cover that
path, so returning immediately from our callback is the one mechanism that covers both. The API is a
long-lived Node process, so an unawaited promise completes.

**Alternatives considered**: `advanced.backgroundTasks.handler` (covers reset and sign-up but not
re-sending verification, so two mechanisms for one rule).

## D3. Password reset options

**Decision**: in `emailAndPassword`: `sendResetPassword`, `resetPasswordTokenExpiresIn` left at its
3600 s default, `revokeSessionsOnPasswordReset: true` (FR-005), and an `onPasswordReset` callback
that marks the address verified (FR-006) and deletes the user's other outstanding reset tokens.

**Rationale**:

* Reset does not touch `emailVerified` (password.mjs:148-174), so FR-006 needs the callback.
* Each reset token is its own `reset-password:<token>` verification row whose value is the user id
  (password.mjs:76). Using one consumes only that row (`consumeVerificationValue`, L157), so older
  links stay usable until they expire. The spec's edge case says using any link must not leave an
  older one usable, so the callback deletes the user's remaining `reset-password:*` rows.
* A Google-only account already gets a working first password: the request sends regardless of
  accounts (L59) and reset creates the credential account when none exists (L161-167). FR-003 needs
  no code beyond the sender.
* Unknown addresses already get an identical response with fake work (L60-72).

## D4. Verification options

**Decision**: `emailVerification` with `sendVerificationEmail`, `sendOnSignUp: true`,
`expiresIn: 86400` (FR-008), and `autoSignInAfterVerification` left unset, which is off (clarified:
the link never signs anyone in). The email's link points at the web app's `/verify-email?token=`
page, not at the API. That page makes sure the learner is signed in to the account named in the
token (switching profile or signing in first), then calls `GET /api/auth/verify-email?token=` with
that session and no `callbackURL`, so failures come back as JSON. A
`emailVerification.beforeEmailVerification` callback refuses unless the request's session belongs to
the user being verified (security review, D12).

**Rationale**: `sendOnSignUp` defaults to `requireEmailVerification`, which stays false (FR-009), so
it must be set explicitly (BA/api/routes/sign-up.mjs:242). Without a `callbackURL`, bad tokens
return 401 JSON with `TOKEN_EXPIRED`, `INVALID_TOKEN`, or `USER_NOT_FOUND`
(email-verification.mjs:166-187). `sendVerificationEmail` receives the token, so the email can carry
the web page's URL. The link also carries the address as `&email=`, which the page uses only to pick
the profile; the token already holds it, so nothing new is exposed, and the server re-checks
everything. (An earlier draft decoded the JWT's payload in the browser, which tied the client to a
private Better Auth format.)

**Spec amendment**: verification tokens are stateless JWTs and are not consumed, so a verification
link opened a second time within 24 hours verifies again rather than reporting "already used". That
is harmless (it can only set a flag that is already set), so the verification page treats a repeat
as "Your address is verified" instead of the "no longer valid" page. User Story 2 scenario 3 is
amended to "expired or invalid". Reset links stay single-use.

## D5. Throttling

**Decision**: per-address limiting of 3 requests per hour (FR-012, SC-006) in a Better Auth
`hooks.before` on `/request-password-reset` and `/send-verification-email`. It keys a dedicated
`TokenBucketStore` (`packages/api/src/lib/rate-limit.ts`) by the lowercased address in the request
body and returns 429 with `Retry-After` when the bucket is empty. It counts requests, not sends.

**Rationale**: Better Auth's limiter keys by `ip|path` only (CORE/utils/ip.mjs:226), with 3 per 60 s
on these two paths in production (BA/api/rate-limiter/index.mjs:370-384). That already covers the
per-client half of FR-012, together with the existing per-IP `unauthedAuthTier` in
`middleware/observability.ts`. Counting requests rather than sends keeps the throttle from revealing
which addresses have accounts (FR-002). The bucket refills smoothly and resets on restart, which is
acceptable for an abuse guard. Better Auth finds the client IP only through its configured headers,
and in production with no IP every request shares one bucket
(BA/api/rate-limiter/index.mjs:281-287). Requests reach the API through Cloudflare Tunnel carrying
`CF-Connecting-IP`, so `advanced.ipAddress` must name that header unless the defaults already do
(checked in T017). Sign-up's own verification email is not counted: sign-up is already IP-limited,
and one account can only be created once.

**Alternatives considered**: Better Auth `rateLimit.storage: "database"` (still IP-keyed); a new
limiter (the existing store already does token buckets).

## D6. Connect Google from settings (phase 2)

**Decision**: the web client calls `authClient.linkSocial({ provider: 'google' })`. A
`databaseHooks.account.create.after` hook marks the user verified when a Google account is linked
(FR-018). This is only sound because D12 removes Google from `trustedProviders`: Better Auth then
creates a Google account row through sign-in or `linkSocial` only when Google reports the address
verified, and `linkSocial` already enforces the same address. The hook sees only the account row, so
it must not be relied on for any path that bypasses those checks; the claim and takeover routes (D7)
verify the user themselves.

**Rationale**: `/link-social` requires a session, enforces the same address unless
`allowDifferentEmails` is set (BA/api/routes/account.mjs:69-222, callback.mjs:102), and does not
check `requireLocalEmailVerified`. It never sets `emailVerified` (callback.mjs:97-131), hence the
hook.

## D7. The takeover choice (phase 2)

**Decision**: catch the refused sign-in instead of letting it redirect with
`error=account_not_linked`:

1. Wrap the Google provider's `mapProfileToUser` to stash the Google profile (`sub`, `email`,
   `email_verified`) in Better Auth request state.
2. A `hooks.after` on `/callback/:id` sees the `account_not_linked` redirect and, only when the
   stashed `email_verified` is `true` (D12), writes a verification row `pending-google:<random>`
   holding the user id, the Google `sub`, and the address, expiring after 10 minutes (FR-021), and
   redirects to the profile picker with that token.
3. "That's me": the learner signs in with the password through the existing email sign-in, then the
   client calls a new authenticated route that consumes the token and links the stored Google `sub`
   to the session's user if the addresses match.
4. "That's not me": the client calls a new unauthenticated route with the token. It consumes the
   token, refuses if the user is already verified (`revokeUnprovenAccountAccess` silently does
   nothing then), removes the credential account and every session (`revokeUnprovenAccountAccess`
   from `better-auth/db`, which does exactly this for an unverified user), links the Google `sub`,
   and verifies the address. The client then starts Google sign-in again, which now finds the linked
   account and signs in normally.

**Rationale**: no hook sees this path except `hooks.after` (BA/oauth2/link-account.mjs:17-29;
`databaseHooks` see no write, and `onAPIError` ignores redirects), and the Google identity is only
reachable by stashing it during the callback (CORE/social-providers/google.mjs:105-113). The token
is the proof that a Google sign-in for that address just completed (FR-021), consumed atomically
with `consumeVerificationValue`. Re-running Google sign-in after the takeover avoids creating a
session by hand alongside the multi-session cookies.

**Risk**: the request-state stash and the after-hook rewrite are inferred from source, not
documented API. Phase 2 starts with a test that drives the refused callback end to end, so a Better
Auth upgrade that breaks it fails loudly. Pin the minor version range (`~1.6.33`, already the case).

**Alternatives considered**: a fork of the callback route (copies Better Auth's OAuth handling);
disabling `requireLocalEmailVerified` (reopens GHSA-g38m-r43w-p2q7).

## D8. Reset account (phase 2)

**Decision**: extend `packages/api/src/lib/reset.ts` so the full reset also deletes the user's
`user_materials`, `user_year_settings`, `material_schedules`, and `graph_snapshots` rows, under the
same engine lock and invalidation that `deleteAccountProgress` uses, behind a new route next to
`DELETE /api/account/progress`. The web reuses `TypeToConfirmDialog` with the address as
`match-text` and the existing backup button (FR-025).

**Rationale**: there are no server-side preferences today (`SettingsPreferencesView.vue` is empty),
so "preferences" in FR-024 means the per-year settings. "Delete all progress" already confirms by
typing the address and offers a backup in the dialog, so FR-025 is already met for it.

## D9. Verification status on the client

**Decision**: carry `emailVerified` on the session user the web already reads, store it on the
profile registry row (`lib/engine/registry.ts`), refresh it on sign-in and on device-session
reconciliation, and show the badge from it on `ProfileCard` (FR-026). Account settings read it for
FR-010 and FR-022.

**Rationale**: the registry row is a cache (Principle VI), rebuilt from the server on reconcile, so
an optional field needs no migration.

## D10. Configuration and deploy

**Decision**: `RESEND_API_KEY` is optional in the API environment, passed through `AuthEnv`. The
sender address `VerseVault <no-reply@versevault.ca>` is a constant (FR-013), not configuration.
`deploy/provision.sh` gains a `prompt_secret RESEND_API_KEY` after the Google prompts, and
`docs/deployment.md` lists it with the optional variables. The production key is already in
`/etc/verse-vault.env` (2026-10-06).

## D11. Scope of validation

No change to `crates/core` or `crates/wasm`, so no contract version bump and no simulation run
(Principle III, IV). Tests are API integration tests through `createTestApp` with a fake sender that
records messages, plus web unit tests for any pure helpers (the web suite has no component tests).

## D12. Security review (2026-10-07)

Two flaws found in the first draft of this design, both in how an address becomes verified, which is
what unlocks implicit Google linking.

**Verification link without the password.** `GET /verify-email` sets `emailVerified` and nothing
else (BA/api/routes/email-verification.mjs:291-293); unlike the magic-link and email-OTP plugins it
does not call `revokeUnprovenAccountAccess`. With the draft's signed-out verification, an attacker
who signs up with someone's address gets the genuine verification email sent to them; if the owner
clicks it, the account is verified with the attacker's password intact, and the owner's later Google
sign-in links into it (BA/oauth2/link-account.mjs:21-46). **Fix**: verification completes only for a
session belonging to that user (D4). Revoking access on a signed-out click instead was rejected: it
would also strip an honest new user's own password and sessions whenever they verify from another
device.

**Google's own `email_verified` ignored.** With `trustedProviders: ['google']`, Better Auth skips
Google's `email_verified` claim in implicit linking (link-account.mjs:23) and `linkSocial`
(callback.mjs:98). Google can report an address it has not verified, for an account registered on a
third-party address. Once phase 1 creates verified local users, such a Google identity could sign
straight into them, and in phase 2 it could reach the takeover. **Fix**: remove Google from
`trustedProviders`, so Better Auth requires the claim for linking; write `pending-google` rows only
when the stashed claim is `true`; the takeover route refuses an already verified user. Gmail and
Workspace addresses always report `true`, so honest users lose nothing.

## D13. Known limitations (2026-10-10)

Accepted after the implementation reviews of phase 1. Each is a deliberate tradeoff, not an
oversight.

**The per-address throttle can block the owner.** The bucket is keyed by address alone and shared by
both paths, so anyone sending one request every 20 minutes for an address keeps its owner from
getting reset or verification email. A per-IP-per-address limit would avoid it but adds a second
store and still falls to an attacker with several IPs. Every refused request is logged with its
status and IP, so a sustained block shows up in the logs.

**Tokens stay in the address bar.** `/reset-password` and `/verify-email` leave `?token=` in place
after reading it. Reset tokens are single-use and verification needs the account's own session, so
the exposure is small, and keeping it means a reload retries the link, which is the recovery path
when verifying fails offline or on a server error.

**A failed verify falls back to sign-in.** When checking the link fails offline or with a 5xx, the
page asks the learner to sign in, even if they already are. Signing in again (or reloading) finishes
it; a dedicated retry button wasn't worth the extra state for a rare case.

**`onPasswordReset` runs before sessions are revoked.** Better Auth sets the new password, then
calls `onPasswordReset`, then revokes sessions (BA/api/routes/password.mjs:168-172). If the hook's
writes (mark verified, delete older reset links) failed, the reset would answer 500 with the new
password live and old sessions intact. Catching the error instead would leave older reset links
silently valid. With a local SQLite file neither write is expected to fail, so the hook is left to
throw.

Follow-up cleanups found in review are filed as #190 (rate limiter eviction and a shared 429
helper), #191 (syncing server-owned profile fields) and #192 (the profile picker's mode changes).
