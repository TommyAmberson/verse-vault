# Implementation Plan: Email Verification and Password Reset

**Branch**: `feat/email-verification-reset` | **Date**: 2026-10-07 | **Spec**: [spec.md](./spec.md)

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

## Technical Context

**Language/Version**: TypeScript (api, web); Vue 3 (web)

**Primary Dependencies**: better-auth ~1.6.33 (already pinned), Hono, Drizzle with better-sqlite3;
Resend HTTPS API over `fetch` (no SDK)

**Storage**: SQLite through Drizzle. Reuses Better Auth's `user.emailVerified`, `account`,
`session`, and `verification` tables; no migration. The web profile registry (IndexedDB) gains an
optional cached `emailVerified` field

**Testing**: vitest. API integration tests through `createTestApp` in
`packages/api/src/test-utils.ts`, with a fake sender that records messages; web unit tests for pure
helpers in `apps/web/src/lib/`

**Target Platform**: Node API on the DigitalOcean droplet behind Cloudflare Tunnel; the web SPA in
browsers and the Tauri shell (email links open in the system browser)

**Project Type**: pnpm workspace (`packages/api`, `apps/web`)

**Performance Goals**: request responses for reset and re-send are indistinguishable in time for
existing and unknown addresses (SC-003); email arrives within a minute (SC-002, provider-bound)

**Constraints**: no account enumeration through wording, timing, errors, or throttling (FR-002);
sending within Resend's free allowance (100 a day, 3,000 a month) via 3 requests per address per
hour (FR-012); no send failure may fail or slow a request

**Scale/Scope**: phase 1 touches `lib/auth.ts`, one new sender module, the app's env wiring, five
web files and two new web pages, four docs, and the provision script. Phase 2 adds two API routes,
two Better Auth hooks, the reset extension, and three web surfaces

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

| Principle                           | Assessment                                                                                                                                                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Design Docs Are Source of Truth  | `docs/server-api.md` (Auth, Account data, Rate limiting), `docs/persistence.md` (verification table use), `docs/deployment.md` (env), and `docs/web-nav.md` (new pages, badge) are updated in the PR that changes each behaviour (FR-017).            |
| II. Pure Core, Thin Edges           | Not engaged: auth lives entirely in `packages/api` and `apps/web`; no algorithm semantics.                                                                                                                                                            |
| III. Contract Versions Are Promises | Not engaged: no change to `crates/core` or `crates/wasm`.                                                                                                                                                                                             |
| IV. Validate Before You Ship        | No scheduling change, so no sim run. Each behaviour gets an API test first (fake sender records the email, the test follows its link). Phase 2's takeover starts with an end-to-end test of the refused callback because it relies on inferred hooks. |
| V. Atomic, Traceable History        | One commit per behaviour; phase 1 and phase 2 are separate PRs (clarified).                                                                                                                                                                           |
| VI. No Client Can Get Stuck         | Engaged lightly: the profile registry's `emailVerified` is a cache refreshed from the server on sign-in and reconcile. "Reset account" reuses `resetProfileLocalData` so no stale cache outlives the server wipe.                                     |
| VII. Simplest Design That Works     | Library behaviour is configured, not re-implemented (see Platform already provides). One new module (the sender); the throttle reuses `TokenBucketStore`; dialogs reuse `TypeToConfirmDialog`. See Reuse and Ownership.                               |

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
├── routes/account.ts         # phase 2: claim and takeover routes, reset route
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
├── components/SignInForm.vue # forgot-password mode
├── components/ProfileCard.vue# unverified badge
├── views/ProfilePickerView.vue   # phase 2: takeover choice
├── views/SettingsAccountView.vue # status, resend, warning; phase 2: Connect Google, Reset account
├── views/ResetPasswordView.vue   # new page
├── views/VerifyEmailView.vue     # new page
└── router/index.ts           # two public routes

deploy/provision.sh           # RESEND_API_KEY prompt
docs/{server-api,persistence,deployment,web-nav}.md
```

**Structure Decision**: existing pnpm workspace layout; no new package.

## Reuse and Ownership

| Decision or write path                                   | Owner                                                                                   | Existing code reused                                                                           |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Delivering an email, and logging instead with no key     | new `packages/api/src/lib/email.ts`                                                     | the injectable-fetch and error-logging shape of `lib/apibible-cache.ts`                        |
| What reset and verification do                           | Better Auth, configured in `createAuth` (`lib/auth.ts`)                                 | `emailAndPassword`, `emailVerification`, `revokeSessionsOnPasswordReset`                       |
| Address verified on reset; older reset links invalidated | `onPasswordReset` in `lib/auth.ts`                                                      | Drizzle on `user` and `verification` (no Better Auth user-update hooks exist to bypass)        |
| 3 requests per address per hour                          | a `hooks.before` in `lib/auth.ts`                                                       | `TokenBucketStore` from `lib/rate-limit.ts`                                                    |
| Per-client throttling                                    | unchanged: Better Auth's built-in limiter and `middleware/observability.ts`             | both, as configured today                                                                      |
| Who may complete a verification                          | `emailVerification.beforeEmailVerification` in `lib/auth.ts` (D12)                      | the request's session via `auth.api.getSession`                                                |
| Which Google identities may link                         | `account.accountLinking` in `lib/auth.ts`: Google removed from `trustedProviders` (D12) | Better Auth's provider `email_verified` check                                                  |
| A matching Google link verifies the address (phase 2)    | a `databaseHooks.account.create.after` in `lib/auth.ts`                                 | `internalAdapter.updateUser`                                                                   |
| Pending Google sign-in record and the choice (phase 2)   | a `hooks.after` on the callback in `lib/auth.ts`; routes in `routes/account.ts`         | `verification` table, `consumeVerificationValue`, `revokeUnprovenAccountAccess`, `linkAccount` |
| What a full reset deletes (phase 2)                      | `lib/reset.ts`                                                                          | `deleteAccountProgress`'s lock and invalidation                                                |
| Typed confirmation and backup before wiping              | `TypeToConfirmDialog` in `SettingsAccountView.vue`                                      | the existing Delete all progress dialog and `onBackupInsideDialog`                             |
| Whether a profile is unverified, on the client           | profile row in `lib/engine/registry.ts`, written by `useAuth.ts`                        | `signInComplete`, `reconcileDeviceSessions`                                                    |
| Message for a refused or failed Google sign-in           | `lib/socialSignInError.ts`                                                              | its `account_not_linked` mapping                                                               |

**Platform already provides**: identical responses and fake work for unknown addresses on reset
request; a 500 ms floor on re-sending verification; single-use reset tokens; a first password for
Google-only accounts through reset; per-IP limits of 3 per minute on both email paths in production;
same-address enforcement in `linkSocial`; `requireLocalEmailVerified` blocking implicit links onto
unverified accounts. None of these is restated in our code.

**Releases**: phase 1 PR: api PATCH and web PATCH. Phase 2 PR: api PATCH and web PATCH. Version
numbers are set when each bump commit is written.

## Phase 2 Preview (ordering, not tasks)

Phase 1 (first PR):

1. Sender and test fake; env wiring; provision prompt and deployment doc.
2. Reset: request, page, sessions revoked, verified, older links dead. Docs.
3. Verification: on sign-up, re-send from settings, page, status in settings, warning. Docs.
4. Per-address throttle.
5. Profile badge; interim `account_not_linked` message.
6. Release bumps.

Phase 2 (second PR, after phase 1 merges):

1. End-to-end test of the refused Google callback, then the stash and the after hook.
2. Takeover and claim routes; the choice screen; re-run Google sign-in.
3. Connect Google in settings and the verifying account hook.
4. Reset account: lib, route, dialog. Docs and release bumps.
