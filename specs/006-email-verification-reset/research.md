# Research: Email Verification and Password Reset

D1 to D13 record phase 1 as built (links). The 2026-10-13 clarifications replace links with codes
and require proof of the inbox before Google links; D14 to D18 record that design, and say which
earlier decisions they supersede.

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

_Still holds in phase 2b: the code sender returns at once the same way._

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

_Superseded in phase 2b by D15: reset is by code, and the plugin verifies the address and rotates
codes itself, so `onPasswordReset` goes._

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

_Superseded in phase 2b by D15: verification is by code; `beforeEmailVerification` stays._

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

**Per IP per day** (added in review, 2026-10-10): Better Auth's per-IP windows reset within a
minute, so they bound bursts, not a day's total. Each IP therefore also gets 10 emails a day, so one
client can't spend the provider's daily quota by signing up many addresses or resetting its own
accounts. Reset and verification requests count in the same hook when they arrive. A sign-up counts
in `sendVerificationEmail`, once its account exists, and over the limit it skips the email rather
than refusing: a team signing up together on one church or school network all get accounts, failed
attempts cost nothing, and anyone who missed the email sends it later from settings. The sign-up
note therefore points to the email rather than promising it. Refusing sign-ups instead would block
the 11th person on a shared network, and sooner when attempts fail.

**Alternatives considered**: Better Auth `rateLimit.storage: "database"` (still IP-keyed); a new
limiter (the existing store already does token buckets).

## D6. Connect Google from settings (phase 2)

**Decision**: the web client calls `authClient.linkSocial({ provider: 'google' })`. The D7 after
hook on the callback marks the user verified when the callback succeeded, Google reported the
address verified, and the account with that address now holds that Google `sub` (FR-018). This is
only sound because D12 removes Google from `trustedProviders`, and `linkSocial` already enforces the
same address. The claim and takeover routes (D7) verify the user themselves.

An earlier draft used a `databaseHooks.account.create.after` hook instead. It fired for every Google
account row created anywhere, including the takeover's own link, which verified the user before the
takeover could revoke the old password: a hidden ordering rule between two files, and a trap for any
later code that creates a Google account. Scoping it to the callback removes both.

**Rationale**: `/link-social` requires a session, enforces the same address unless
`allowDifferentEmails` is set (BA/api/routes/account.mjs:69-222, callback.mjs:102), and does not
check `requireLocalEmailVerified`. It never sets `emailVerified` (callback.mjs:97-131), hence the
hook.

## D7. The takeover choice (phase 2)

**Decision**: catch the refused sign-in instead of letting it redirect with
`error=account_not_linked`:

1. Wrap the Google provider's `mapProfileToUser` to stash the Google profile (`sub`, `email`,
   `email_verified`) in Better Auth request state. Request state comes from
   `@better-auth/core/context` (`defineRequestState`); `better-auth` doesn't export it, so phase 2
   adds `@better-auth/core` as a direct dependency pinned to the same version as `better-auth`, and
   upgrades move both together.
2. A `hooks.after` on `/callback/:id` sees the `account_not_linked` redirect and, only when the
   stashed `email_verified` is `true` (D12), writes a verification row `pending-google:<random>`
   holding the user id, the Google `sub`, and the address, expiring after 10 minutes (FR-021), and
   redirects to the profile picker with that token.
3. "That's me": the learner signs in with the password through the existing email sign-in, then the
   client calls a new authenticated route that consumes the token and links the stored Google `sub`
   to the session's user if the addresses match.
4. "That's not me": the client calls a new unauthenticated route with the token. It consumes the
   token, refuses if the user is already verified, removes the credential account and every session
   (what `revokeUnprovenAccountAccess` from `better-auth/db` does, done directly through the
   internal adapter since the route has no Better Auth endpoint context), links the Google `sub`,
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

From phase 2b the Google code step shares the address's verification code (D16), so the same person,
or anyone signed in to an unverified account through a password they set, can also request a new
verification code and so replace the one the owner was emailed for Google. Password reset still gets
the owner in.

**Many clients together can still spend the sending quota.** The per-IP daily limit (D5) stops one
client, but not requests spread across many IPs. Once the provider's daily quota is gone, reset and
verification email fails until the next day, logged but otherwise silent. A global daily cap in the
API wouldn't help, since email would stop at our cap instead of the provider's. The defences are a
challenge on the forms (Better Auth's captcha plugin supports Cloudflare Turnstile) and an alert
when the provider refuses for quota, filed as #194.

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

## Phase 2 revision (2026-10-13)

## D14. Which Google sign-ins prove the inbox (phase 2a)

**Decision**: the Google provider's `mapProfileToUser` returns `emailVerified` as true only when
Google is authoritative for the address: Google reports `email_verified` and the address ends in
`@gmail.com` or `@googlemail.com` (older UK and German Gmail), or the token carries an `hd` claim (a
Workspace account; an organization proves it owns a domain before giving users addresses on it, so
`hd` names only the primary one). It also stashes the raw `email_verified` alongside, for D16.

**Rationale**: Google's guidance ("Verify the Google ID token on your server side": "Using the
email, email_verified and hd fields") is authoritative only for Gmail and Workspace accounts; for
any other address `email_verified` records a check made when the Google account was created, and
"ownership of the third party email account may have since changed". Better Auth spreads the mapped
fields over the user info (CORE/social-providers/google.mjs:113-122), and every decision that trusts
Google's address reads that one value:

* implicit linking into an existing account (BA/oauth2/link-account.mjs:23) and the `emailVerified`
  it then sets (L46);
* `linkSocial`'s check for an untrusted provider (BA/api/routes/callback.mjs:97);
* a new Google user's `emailVerified` at sign-up.

So one rule in one place closes the gap in production, where a Google account on someone's old Yahoo
address would sign straight into their verified VerseVault account. Gmail usernames are never
reissued. A lapsed Workspace domain that is re-registered hands over its inboxes too, so this is no
weaker than any email-based recovery.

**Alternatives considered**: checking in the callback after hook (it runs after Better Auth has
already linked or created the user); trusting `email_verified` for every address (the gap above).

## D15. Codes instead of links (phase 2b)

**Decision**: Better Auth's `emailOTP` plugin, with `overrideDefaultEmailVerification: true` so
verification on sign-up and on request sends a code instead of a link, `expiresIn: 600`, and
`storeOTP: 'hashed'`; the plugin's defaults already give 6 digits and 3 wrong attempts. Its
`sendVerificationOTP` callback sends through the D1 sender with a template per `type`. Reset uses
the plugin's code routes; `sendResetPassword`, `sendVerificationEmail`, and `onPasswordReset` go.
Better Auth's `disabledPaths` refuses the plugin routes outside this spec: code sign-in
(`/sign-in/email-otp`), changing email (`/email-otp/request-email-change`,
`/email-otp/change-email`), the deprecated `/forget-password/email-otp`, and checking a code without
using it (`/email-otp/check-verification-otp`). The router checks it, so it refuses only requests
that arrive over HTTP; D16's confirm route calls the check through `auth.api`. A `hooks.before`
refuses `type: 'sign-in'` and `'change-email'` on the send route the same way. The `/reset-password`
and `/verify-email` web pages stay as routes that tell anyone arriving from an older email to
request a code (FR-011).

**Rationale**:

* Verify by code calls `beforeEmailVerification` (BA/plugins/email-otp/routes.mjs:325), so the D12
  rule, verified only for that account's own session, holds unchanged.
* Reset by code creates a first password for a Google-only account, marks the address verified, and
  ends every session when `revokeSessionsOnPasswordReset` is set (routes.mjs:590-600), so FR-003,
  FR-005, and FR-006 need no code of ours.
* There is one row per address and type (`<type>-otp-<email>`), and a new request replaces it
  (`resolveOTP`, rotate strategy), so only the newest code works, which is what `onPasswordReset`
  used to enforce for links. The plugin replaces the row only when creating the new one fails on a
  unique `identifier`, so migration 0030 makes that index unique; without it a resend kept both
  rows, and lookups that take the newest by `created_at` (whole seconds) could pick either.
* Wrong attempts are counted on the row and lock it after three (`atomicVerifyOTP`, routes.mjs:760).
  The verify and reset routes consume the row before comparing and recreate it on a wrong guess, so
  guesses sent at the same moment still get three tries between them.
* The check route is different: it reads the row, compares, and writes the new count back as
  separate steps (routes.mjs:239-252), so guesses sent at the same moment each see the old count.
  Its own limit is 3 per 60 s per IP, so guesses spread over many networks get far more than three
  tries at one code, including a reset code someone else requested for the address, which the reset
  route then accepts. Nothing in the client needs it, so it is refused.
* Anyone can ask for a code for any address, and a new code replaces the older one, so someone else
  can replace the code a learner is about to type. The codes go only to the learner's inbox, so the
  newest one still works, and the per-address limit (3 an hour) caps how long they can be held up:
  about 20 minutes, while the other party keeps at it. This matches how major providers do it (Auth0
  invalidates earlier email codes; Supabase waits 60 seconds between sends per user), and OWASP's
  concern is flooding the owner's inbox, which the per-address limit covers. Keeping the older code
  (the plugin's `resendStrategy: 'reuse'`) needs codes stored decryptably, so the fields say "Only
  the code in the newest email works" instead.
* Unknown addresses get `{ success: true }` and no send on both the reset and verification send
  routes, after the same store-and-delete work (routes.mjs:100-110, 478-490). SC-003's timing test
  covers the reset route as before.
* With the override, the plugin replaces `emailVerification.sendVerificationEmail`
  (BA/plugins/email-otp/index.mjs:22-34), so sign-up's existing `sendOnSignUp` sends a code. The
  per-IP count for sign-up moves into `sendVerificationOTP`, which still sees the sign-up request.
* Codes resolve two D13 limitations: no token sits in the address bar, and verification needs no
  profile switching page, since the code is typed into the account that asked for it.

**Alternatives considered**: keeping links for verification and reset (two mechanisms; the
clarification chose codes); writing our own code store (the plugin already hashes, rotates, counts
attempts, and expires codes).

## D16. The Google code step (phase 2b)

**Decision**: the callback after hook (D7) also handles a refused Google sign-in whose raw
`email_verified` is true but which D14 found non-authoritative.

* Verified account: refused with a message to sign in with the password and connect Google from
  settings (D17). OWASP's account-linking guidance asks for an authenticated session on the account
  before adding a linked identity, and an emailed code alone would let anyone who can get the owner
  to read out a code link a Google account they control.
* Unverified password account: the code step. The hook writes the pending row, marked as not yet
  proven, with the hash of a new code and its wrong-try count, emails that code in a message saying
  a Google account is being connected, and redirects to the picker with `&code=1`.
  `POST /api/account/google/confirm { code }` checks it against the row, then marks the row proven
  and returns `{ choice: true }`; the picker shows "That's me" / "That's not me".

The code lives in the pending row rather than the email-code plugin's shared verification row, so it
works for this step only and a code sent for anything else can't pass it (purpose binding, as in
[Bird's OTP guidance](https://bird.com/blog/what-does-otp-mean)), and a Google sign-in never
replaces the owner's own verification code.

The route runs one check at a time per address, holding an in-process lock keyed on the address from
the check through the delete, so each guess sees the count the one before it wrote. The
observability middleware puts the route in the tight per-IP bucket that `/api/auth/*` uses.

The pending token goes in an HTTP-only cookie sent only to `/api/account/google`, not in the
picker's address, so only the browser that signed in with Google can act on the row. Otherwise
whoever holds a stale Google account for an address could forward their picker address to the
inbox's owner, who would enter the code just emailed and link the stranger's Google account. That
code's email says a Google account is being connected and to enter it only if the reader did that,
and the owner is told by email whenever Google joins an account that already signs in another way,
as [Ory](https://www.ory.com/blog/secure-account-linking-iam-sso-oidc-saml) and
[WorkOS](https://workos.com/blog/oauth-auto-link-email-account-takeover) recommend. The Google step
always sends its own code, replacing any older one, rather than keeping a code the address already
holds: a kept code arrived in an email about something else, while guidance on code messages is to
say what each code is for, and Auth0 likewise lets only the newest code work. A Google sign-in can
therefore replace a code the owner was about to type, the trade-off D15 accepts for every send.

The notice's advice has to work, so account settings can disconnect Google while the account keeps a
password. This is the usual "connected accounts" pattern, and NIST SP 800-63B-4 requires notifying
the subscriber whenever an authenticator is added. A password reset leaves Google connected, as most
products do; the owner resets, signs in, and disconnects.

Claim and takeover refuse a pending row that is not proven. An authoritative refusal writes it
proven from the start, as phase 2 already does.

**Rationale**: the pending row already ties the proof to one Google identity and one account, so it
is the natural home for the code that proves the inbox for that sign-in. The confirm route compares
the code's SHA-256 hash in constant time and counts wrong tries on the row; it runs one check at a
time per address, holding an in-process lock, so tries sent at the same moment each see the count
the one before wrote, and only one right code passes. The lock is enough because the API runs as one
Node process against one SQLite file (`deploy/verse-vault.service`). The send goes through the same
per-address and per-IP limits as the plugin's routes (FR-012).

Disconnecting Google ends every other session, as OWASP asks ("the account must no longer be
accessible through that identity"). Better Auth's `unlinkAccount` deletes one link and leaves
sessions alone, so our own route removes every Google account and the other sessions in one server
step, which a client-side follow-up call could fail to do. A takeover likewise removes every way in
except the new Google link, not only the password, since a registrant may have linked a Google
account of their own. Better Auth doesn't record how a session started, so every other session ends,
not only those started through Google.

**Alternatives considered**: the email-code plugin's shared verification row (the first design: a
code sent for verification could pass the Google step, and a Google sign-in replaced the owner's own
code); linking a verified account on the code alone (the first design too, dropped for OWASP's
session rule above); signing the learner in directly after the code (the multi-session cookies argue
for re-running Google sign-in, as D7 did for takeover).

## D17. Connect Google from settings (phase 2b)

**Decision**: with D14 in place, `linkSocial` links an authoritative Google account as before, and
the D6 verify in the after hook still applies. For a non-authoritative one Better Auth refuses with
`unable_to_link_account` (BA/api/routes/callback.mjs:97-100); the after hook turns that into a link
when the signed-in account is already verified, the Google address matches it, and that Google `sub`
is not linked elsewhere. An unverified account instead comes back with an error the settings page
explains: verify the address with a code first, then connect Google. That code is the D15
verification code, so it verifies the address on the way (clarification 2026-10-13).

**Rationale**: the session proves the account and a verified account has already proven the inbox,
so a verified account needs nothing more. An unverified one must prove the inbox before gaining a
sign-in method, or whoever pre-registered the address could attach their own Google account, which a
reset would not remove.

**Alternatives considered**: a separate code step inside Connect Google (the verification code in
settings is the same proof, already built).

## D18. Delivery (2a, 2b, 2c)

**Decision**: three pull requests, each with api and web PATCH releases where they touch them.

* **2a** (`fix/google-authoritative-email`, off master): D14, with tests that an authoritative Gmail
  or Workspace sign-in links as before and an outside address does not link, does not verify, and
  signs up unverified; the `account_not_linked` message reworded for the new reason. No web pages
  change.
* **2b** (`feat/inbox-codes`, off master, carrying the Google commits from the earlier branch): D15
  to D17, the choice screen, takeover, and Connect Google. Already-built work carries over: the
  callback after hook and pending rows, claim and takeover, the picker choice, Connect Google, and
  the docs for them.
* **2c** (`feat/reset-account`, off master): Reset account (User Story 5), whose commits move over
  unchanged.

**Rationale**: 2a closes a gap already live and is small, so it should not wait on the code rework.
Reset account is independent of the Google work.
