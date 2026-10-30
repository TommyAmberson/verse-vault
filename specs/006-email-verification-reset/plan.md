# Implementation Plan: Email Verification and Password Reset

**Branch**: `feat/email-verification-reset` (phase 1), then 2a, 2b, 2c (research D18) | **Date**:
2026-10-07, revised 2026-10-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/006-email-verification-reset/spec.md`

## Summary

Better Auth already implements most of this. Phase 1 turns on its reset and verification flows,
supplies the sender, and fills the three gaps the library leaves: marking the address verified on
reset, invalidating older reset links, and throttling per address. The web gains a forgot-password
mode in the sign-in form, reset and verification pages, verification status in account settings, and
an "unverified" badge in the profile picker. Phase 2 adds "Connect Google" through Better Auth's
`linkSocial`, catches the refused Google sign-in to offer the takeover choice, and adds "Reset
account" beside the existing "Delete all progress". Two security decisions shape both phases
(research D12): a verification link verifies only for a session belonging to that user, and Google
is no longer a trusted provider, so Google's own `email_verified` is required before it links into
an account. No schema change, no contract crate change.

The 2026-10-13 clarifications revise phase 2 into three pull requests. **2a** makes Google's address
count as verified only where Google is authoritative for it (Gmail, or Workspace with an `hd`
claim), in the provider's `mapProfileToUser`, closing a gap already in production (D14). **2b**
replaces links with codes through Better Auth's `emailOTP` plugin (D15), adds an emailed code before
a non-authoritative Google sign-in can link or reach the choice (D16), and limits Connect Google to
verified accounts unless Google is authoritative (D17), carrying over the choice screen, takeover,
and Connect Google already built. **2c** is Reset account.

## Technical Context

**Language/Version**: TypeScript (api, web); Vue 3 (web)

**Primary Dependencies**: better-auth ~1.6.33 (already pinned), plus `@better-auth/core` at the same
version as a direct dependency in phase 2, for `defineRequestState` (D7), which `better-auth`
doesn't re-export; Hono, Drizzle with better-sqlite3; Resend HTTPS API over `fetch` (no SDK)

**Storage**: SQLite through Drizzle. Reuses Better Auth's `user.emailVerified`, `account`,
`session`, and `verification` tables. 2b adds two migrations: 0030 makes `verification.identifier`
unique, which the email-code plugin needs to replace an older code on resend, and 0031 makes
`account(provider_id, account_id)` unique, so one Google account can't link to two users. The web
profile registry (IndexedDB) gains an optional cached `emailVerified` field

**Testing**: vitest. API integration tests through `createTestApp` in
`packages/api/src/test-utils.ts`, with a fake sender that records messages; web unit tests for pure
helpers in `apps/web/src/lib/`

**Target Platform**: Node API on the DigitalOcean droplet behind Cloudflare Tunnel; the web SPA in
browsers and the Tauri shell (email links open in the system browser)

**Project Type**: pnpm workspace (`packages/api`, `apps/web`)

**Performance Goals**: request responses for reset and re-send are indistinguishable in time for
existing and unknown addresses (SC-003); email arrives within a minute (SC-002, provider-bound)

**Constraints**: no account enumeration through wording, timing, errors, or throttling (FR-002);
normal sending within Resend's free allowance (100 a day, 3,000 a month), with 3 requests per
address per hour so no inbox can be flooded (FR-012) and 10 per IP per day so no one client can
spend the quota (research D5, D13); no send failure may fail or slow a request

**Scale/Scope (2a to 2c)**: 2a is one provider option, its tests, a message, and docs. 2b adds the
plugin, a `hooks.before` refusing its out-of-scope routes, one confirm route, code fields in the
sign-in form, settings, and the picker, and turns the two link pages into "request a code" pages. 2c
is one lib extension, one route, and a settings card.

**Scale/Scope (phase 1)**: phase 1 touches `lib/auth.ts`, one new sender module, the app's env
wiring, five web files and two new web pages, four docs, and the provision script. Phase 2 adds two
API routes, two Better Auth hooks, the reset extension, and three web surfaces

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

| Principle                           | Assessment                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Design Docs Are Source of Truth  | `docs/server-api.md` (Auth, Account data, Rate limiting), `docs/persistence.md` (verification table use), `docs/deployment.md` (env), and `docs/web-nav.md` (new pages, badge) are updated in the PR that changes each behaviour (FR-017).                                                                                                                                                        |
| II. Pure Core, Thin Edges           | Not engaged: auth lives entirely in `packages/api` and `apps/web`; no algorithm semantics.                                                                                                                                                                                                                                                                                                        |
| III. Contract Versions Are Promises | Not engaged: no change to `crates/core` or `crates/wasm`.                                                                                                                                                                                                                                                                                                                                         |
| IV. Validate Before You Ship        | No scheduling change, so no sim run. Each behaviour gets an API test first (fake sender records the email, the test reads its code). Phase 2's takeover starts with an end-to-end test of the refused callback because it relies on inferred hooks. 2a tests each Google case (Gmail, Workspace, outside address) through the stubbed callback; 2b tests codes end to end with the fake sender.   |
| V. Atomic, Traceable History        | One commit per behaviour; phase 1 and phase 2 are separate PRs (clarified).                                                                                                                                                                                                                                                                                                                       |
| VI. No Client Can Get Stuck         | Engaged lightly: the profile registry's `emailVerified` is a cache refreshed from the server on sign-in and reconcile. "Reset account" reuses `resetProfileLocalData` so no stale cache outlives the server wipe.                                                                                                                                                                                 |
| VII. Simplest Design That Works     | Library behaviour is configured, not re-implemented (see Platform already provides). One new module (the sender); the throttle reuses `TokenBucketStore`; dialogs reuse `TypeToConfirmDialog`. See Reuse and Ownership. 2b uses Better Auth's `emailOTP` plugin rather than a code store of our own, and the Google code step reuses it; `onPasswordReset` goes because the plugin does its work. |

**Result**: PASS, no violations. Re-checked after Phase 1 design: still PASS.

## Project Structure

### Documentation (this feature)

```text
specs/006-email-verification-reset/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── http.md          # Better Auth endpoints used, callbacks, new routes
│   └── ui.md            # web pages and states, email contents
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
packages/api/src/
├── index.ts                  # reads RESEND_API_KEY into AuthEnv
├── app.ts                    # passes the sender dep through
├── lib/auth.ts               # reset, verification, hooks (both phases)
├── lib/email.ts              # new: Resend sender and message bodies
├── lib/reset.ts              # phase 2: full account reset
├── lib/rate-limit.ts         # reused for the per-address bucket
├── routes/account.ts         # 2b: confirm, claim, takeover routes; 2c: reset route
└── test-utils.ts             # fake sender in the test app

apps/web/src/
├── api.ts                    # phase 2: full account reset call
├── assets/auth-form.css      # styles shared by the sign-in form and both email pages
├── composables/useEmailRequest.ts # busy flag and message for "email me a link" buttons
├── lib/authClient.ts         # reset, verification, linkSocial wrappers
├── lib/authEmail.ts          # what the learner sees after an email request
├── lib/socialSignInError.ts  # interim and phase 2 messages
├── lib/engine/registry.ts    # cached emailVerified on profile rows
├── composables/useAuth.ts    # carries emailVerified into rows
├── components/SignInForm.vue # forgot-password mode; 2b: code fields
├── components/ProfileCard.vue# unverified badge
├── views/ProfilePickerView.vue   # 2b: code step and takeover choice
├── views/SettingsAccountView.vue # status, resend, warning; phase 2: Connect Google, Reset account
├── views/ResetPasswordView.vue   # new page; 2b: "request a code" page
├── views/VerifyEmailView.vue     # new page; 2b: "request a code" page
└── router/index.ts           # two public routes

deploy/provision.sh           # RESEND_API_KEY prompt
docs/{server-api,persistence,deployment,web-nav}.md
```

**Structure Decision**: existing pnpm workspace layout; no new package.

## Reuse and Ownership

| Decision or write path                                   | Owner                                                                                   | Existing code reused                                                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Delivering an email, and logging instead with no key     | new `packages/api/src/lib/email.ts`                                                     | the injectable-fetch and error-logging shape of `lib/apibible-cache.ts`                                       |
| What reset and verification do                           | Better Auth, configured in `createAuth` (`lib/auth.ts`)                                 | `emailAndPassword`, `emailVerification`, `revokeSessionsOnPasswordReset`; from 2b the `emailOTP` plugin (D15) |
| Address verified on reset; older reset links invalidated | phase 1: `onPasswordReset` in `lib/auth.ts`; from 2b the plugin                         | Drizzle on `user` and `verification`; from 2b the plugin's reset and code rotation                            |
| 3 requests per address per hour                          | a `hooks.before` in `lib/auth.ts`, on the plugin's send routes from 2b                  | `TokenBucketStore` from `lib/rate-limit.ts`                                                                   |
| Which Google sign-ins prove the inbox (2a)               | the Google provider's `mapProfileToUser` in `lib/auth.ts` (D14)                         | Better Auth's own uses of the mapped `emailVerified`                                                          |
| Code routes outside the spec refused (2b)                | Better Auth's `disabledPaths`, plus the `hooks.before` for the send route's types       | the router's own refusal, HTTP only                                                                           |
| The Google code step (2b)                                | the callback `hooks.after` in `lib/auth.ts`; the confirm route in `routes/account.ts`   | `createVerificationOTP` under `chargeSend`, and `checkVerificationOTP`; the pending row (D16)                 |
| Connect Google for a non-authoritative account (2b)      | the callback `hooks.after` in `lib/auth.ts` (D17)                                       | `linkSocial`, the session, `internalAdapter.linkAccount`                                                      |
| Per-client throttling                                    | Better Auth's limiter, `observability.ts`, 10 emails per IP a day in `lib/auth.ts` (D5) | both, as configured today                                                                                     |
| Who may complete a verification                          | `emailVerification.beforeEmailVerification` in `lib/auth.ts` (D12)                      | the request's session via `auth.api.getSession`                                                               |
| Which Google identities may link                         | `account.accountLinking` in `lib/auth.ts`: Google removed from `trustedProviders` (D12) | Better Auth's provider `email_verified` check                                                                 |
| A matching Google link verifies the address (phase 2)    | the callback `hooks.after` in `lib/auth.ts` (D6)                                        | `internalAdapter.updateUser`                                                                                  |
| Pending Google sign-in record and the choice (phase 2)   | a `hooks.after` on the callback in `lib/auth.ts`; routes in `routes/account.ts`         | `verification` table, `consumeVerificationValue`, `revokeUnprovenAccountAccess`, `linkAccount`                |
| What a full reset deletes (phase 2)                      | `lib/reset.ts`                                                                          | `deleteAccountProgress`'s lock and invalidation                                                               |
| Typed confirmation and backup before wiping              | `TypeToConfirmDialog` in `SettingsAccountView.vue`                                      | the existing Delete all progress dialog and `onBackupInsideDialog`                                            |
| Whether a profile is unverified, on the client           | profile row in `lib/engine/registry.ts`, written by `useAuth.ts`                        | `signInComplete`, `reconcileDeviceSessions`                                                                   |
| Message for a refused or failed Google sign-in           | `lib/socialSignInError.ts`                                                              | its `account_not_linked` mapping                                                                              |

Phase 2's account routes reach Better Auth's internals through `auth.$context`, passed in from
`app.ts`; the takeover route sits outside `requireAuth()`.

**Platform already provides**: identical responses and fake work for unknown addresses on reset
request; a 500 ms floor on re-sending verification; single-use reset tokens; a first password for
Google-only accounts through reset; per-IP limits of 3 per minute on both email paths in production;
same-address enforcement in `linkSocial`; `requireLocalEmailVerified` blocking implicit links onto
unverified accounts. From 2b, the `emailOTP` plugin: 6-digit code generation, hashed storage (one
option), rotation on resend, a limit of 3 wrong attempts, expiry, the same reply for unknown
addresses, and reset by code creating a first password, verifying, and ending sessions. None of
these is restated in our code.

**Releases**: phase 1 PR: api PATCH and web PATCH. 2a: api PATCH, and web PATCH for the reworded
message. 2b: api PATCH and web PATCH. 2c: api PATCH and web PATCH. Version numbers are set when each
bump commit is written.

## Phase 2 Preview (ordering, not tasks)

Phase 1 (first PR):

1. Sender and test fake; env wiring; provision prompt and deployment doc.
2. Reset: request, page, sessions revoked, verified, older links dead. Docs.
3. Verification: on sign-up, re-send from settings, page, status in settings, warning. Docs.
4. Per-address throttle.
5. Profile badge; interim `account_not_linked` message.
6. Release bumps.

Phase 2a (after phase 1, its own branch off master):

1. Test each Google case through the stubbed callback, then the `mapProfileToUser` rule.
2. Reword `account_not_linked`. Docs and release bumps.

Phase 2b (`feat/inbox-codes`, with the Google commits from the earlier branch; 2c is
`feat/reset-account`):

1. The plugin with codes for verification and reset; the refused routes; the throttle on the new
   paths; per-IP counting moved to the code sender. Tests first.
2. Code fields in the sign-in form, after sign-up, and in settings; the two link pages become
   "request a code" pages.
3. The Google code step: the after hook sends a code and redirects with `code=1`; the confirm route;
   claim and takeover require a proven row. The picker's code step before the choice.
4. Connect Google limited to verified accounts unless Google is authoritative. Docs and release
   bumps.

Phase 2c: Reset account (lib, route, dialog), docs, release bumps.
