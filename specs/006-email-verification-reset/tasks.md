---

description: "Task list for email verification and password reset"
---

# Tasks: Email Verification and Password Reset

**Input**: Design documents from `specs/006-email-verification-reset/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Constitution IV. API behaviour is proved by integration tests through `createTestApp`
with the fake sender from T002, following the recorded link. Web tests cover pure helpers only (the
suite has no component tests).

**Organization**: Two pull requests (clarified). PR 1 is Phases 1 to 6 (User Stories 1 to 3). PR 2
is Phases 7 to 9 (User Stories 4 and 5) and starts after PR 1 merges.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

<!--
  ============================================================================
  TASK WRITING RULES (project override; constitution principle VII)
  These rules and the constitution override the speckit-tasks skill's
  defaults: tests are not optional where the testing principle calls for
  them, and stories are not ordered Models -> Services -> Endpoints.
  Keep this comment in the generated tasks.md, so commands that add tasks
  later (/speckit-converge) see the same rules.

  - Describe the behaviour, and the test that proves it where the testing
    principle calls for one, not the code. Name a function, signature, option,
    or literal only when the task changes an existing one or the spec,
    data-model.md, or contracts/ already fixes it. Let implementation choose new names; naming the file a change
    lands in is fine.
  - Every decision or write path the feature adds has one owner, named in
    plan.md's "Reuse and Ownership" table. A task that touches it points at that
    owner; never split one rule's implementation across several tasks or files.
  - Reuse first. A task that adds a helper, module, type, or test fixture names
    the existing code it checked and why that doesn't fit. Test tasks extend
    existing fixtures and stubs rather than copying them.
  - No speculative surface: every new production export has a caller the
    constitution accepts, and no task adds an option, reason code, or counter
    that only a test reads.
  - Don't specify framework or library defaults; plan.md records what the
    platform already provides.
  - Name the packages a release bumps and the semver level of each, never the
    resulting version number. The number is set when the bump commit is
    written, from master at that time, and a hotfix landing first takes it.
  - Prefer one task per coherent change over one task per layer (model, then
    service, then endpoint). Split only where tasks can genuinely run or be
    reviewed apart.
  ============================================================================
-->

## Phase 1: Setup

**Purpose**: deploy-side configuration the sender needs

- [X] T001 [P] Add an optional, hidden `RESEND_API_KEY` prompt after the Google prompts in `deploy/provision.sh` (reuse `prompt_secret`), and list `RESEND_API_KEY` with the optional variables in `docs/deployment.md`, noting that without it the API logs links instead of sending (research D10)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the sender every story uses

- [X] T002 Add the email sender in new `packages/api/src/lib/email.ts` (owner per plan.md; follows `lib/apibible-cache.ts`'s injectable `fetch` and error logging; no existing module sends email). It POSTs to the Resend API from the constant sender `VerseVault <no-reply@versevault.ca>`, builds the reset and verification messages from `contracts/ui.md` (plain text plus a minimal HTML button, link also as plain text, why it was sent, expiry, ignore-if-not-you), never throws to its caller, logs a failure with status and truncated body but never the link (FR-015), and with no key logs the link instead (FR-016). Read `RESEND_API_KEY` in `packages/api/src/index.ts` into `AuthEnv` and pass a sender through `AppDeps` in `packages/api/src/app.ts`; extend `createTestApp` in `packages/api/src/test-utils.ts` with a fake sender that records messages so tests can read the link. Cover the no-key and failing-provider paths with unit tests next to the module

**Checkpoint**: sender wired; user stories can start

---

## Phase 3: User Story 1 - Reset a forgotten password (Priority: P1) 🎯 MVP

**Goal**: a learner who forgot their password gets back in by email.

**Independent Test**: create a password account, request a reset, follow the recorded link, set a new password; the old one fails, the new one works, other sessions are gone.

### Tests for User Story 1

> **NOTE: Where a task adds a new test, write it first and see it fail.**

- [X] T003 [US1] In the `auth` describe block of `packages/api/src/index.test.ts`, add tests: an existing address gets one reset email and an unknown address gets the identical response and no email (FR-002); with a fake sender whose send never resolves, a reset request for an existing address still returns, proving the send is not awaited (SC-003, research D2); following the link and posting a new password makes the old password fail and the new one work (FR-004); every prior session for the user is gone (FR-005); the user is verified afterwards (FR-006); a second, older reset link is rejected after one is used (spec edge case); a used or expired token is rejected (FR-011); a Google-only user (insert the account row directly) can set a first password through reset (FR-003)

### Implementation for User Story 1

- [X] T004 [US1] Turn on reset in `createAuth` in `packages/api/src/lib/auth.ts`: `sendResetPassword` starts the send through the T002 sender without awaiting it (research D2), `revokeSessionsOnPasswordReset: true`, and an `onPasswordReset` callback that marks the user verified and deletes the user's other `reset-password:*` verification rows (owner per plan.md; research D3). The reset `redirectTo` is `<web origin>/reset-password` (contracts/http.md). Covered by T003
- [X] T005 [P] [US1] Add a forgot-password mode to `apps/web/src/components/SignInForm.vue`, reached from email sign-in, with one address field; after submit always show "If an account exists for that address, a reset email is on its way", and on 429 "Too many requests for this address. Try again later." (contracts/ui.md). Add the request call next to the existing wrappers in `apps/web/src/lib/authClient.ts`
- [X] T006 [P] [US1] Add the public `/reset-password` page in new `apps/web/src/views/ResetPasswordView.vue` and its route in `apps/web/src/router/index.ts` (public, like `/profiles`): with `?token=` a new-password form under the sign-up rules that posts the reset and then offers sign-in; with `?error=` "This link is no longer valid" and a field to request a new one (FR-011, contracts/ui.md)
- [X] T007 [US1] Document reset in `docs/server-api.md` §Auth (the three Better Auth reset endpoints from contracts/http.md, sessions revoked, verified on reset, older links invalidated) and the `reset-password:*` verification rows in `docs/persistence.md` (FR-017)

**Checkpoint**: reset works end to end

---

## Phase 4: User Story 2 - Verify the address at sign-up (Priority: P2)

**Goal**: new password accounts get a verification email and stay usable before verifying.

**Independent Test**: sign up, sign in before verifying, follow the recorded link, see the address verified.

### Tests for User Story 2

- [X] T008 [US2] In `packages/api/src/index.test.ts`'s `auth` block, add tests: sign-up sends one verification email and the new account can sign in unverified (FR-007, FR-009); calling `GET /api/auth/verify-email?token=` with that user's session verifies the user and creates no new session (FR-008); calling it with no session, or with another user's session, returns 403 and leaves the user unverified (FR-008, research D12); the attack from D12 fails: sign up as A, keep A's session, then follow A's link with no session and assert A is still unverified; an expired or invalid token returns 401 JSON (FR-011); a valid link used twice by the right session still succeeds (research D4)

### Implementation for User Story 2

- [X] T009 [US2] Turn on verification in `createAuth` in `packages/api/src/lib/auth.ts`: `sendVerificationEmail` starts the send without awaiting it, `sendOnSignUp: true`, `expiresIn: 86400`, the email links to `<web origin>/verify-email?token=` built from the token Better Auth passes the callback, and a `beforeEmailVerification` callback refuses unless the request's session belongs to the user being verified (owner per plan.md; research D4, D12; contracts/http.md). Covered by T008
- [X] T010 [P] [US2] Add the public `/verify-email` page in new `apps/web/src/views/VerifyEmailView.vue` and its route in `apps/web/src/router/index.ts`, per contracts/ui.md: read the address from the token's payload (to pick the profile only; the server re-checks), make that account the active session (switch to it if this device holds it, otherwise "Sign in to finish verifying" with email sign-in prefilled), then call the verify endpoint and show "Your address is verified"; never sign out the active profile (FR-008, spec edge cases "Signed in as a different profile" and "A verification email for an account I did not create"); on 401 "This link is no longer valid" and a way to request a new one. After sign-up in `SignInForm.vue`, tell the learner to check their inbox (US2 scenario 1)
- [X] T011 [US2] Document verification in `docs/server-api.md` §Auth (sign-up sends, the verify endpoint and its errors, links reusable within 24 hours, never signs in) (FR-017)

**Checkpoint**: new accounts verify

---

## Phase 5: User Story 3 - Verify an existing account later (Priority: P2)

**Goal**: unverified learners see their status and can request a new verification email.

**Independent Test**: on an unverified account, settings show the status and warning; requesting verification sends one email; the profile picker shows the badge until verified.

### Tests for User Story 3

- [ ] T012 [P] [US3] In `packages/api/src/index.test.ts`'s `auth` block, test that a signed-in unverified user can request a verification email and receives one, and that the session user carries `emailVerified` false then true after following the link (the field the web reads in T013)

### Implementation for User Story 3

- [ ] T013 [US3] Carry `emailVerified` from the session user into the cached profile row: add the optional field to the row in `apps/web/src/lib/engine/registry.ts` and write it where `apps/web/src/composables/useAuth.ts` writes rows (`signInComplete` and `reconcileDeviceSessions`); absent means unknown (data-model.md, research D9)
- [ ] T014 [P] [US3] In `apps/web/src/views/SettingsAccountView.vue`, show "Verified" or "Not verified" for the address; when not verified, a "Send verification email" button (re-send call added to `apps/web/src/lib/authClient.ts`, 429 handled as in T005) and the warning "Until you verify, anyone with access to this inbox can take over this account." (FR-010, FR-022; the Google part of the warning arrives with the takeover in T025). Depends on T013
- [ ] T015 [P] [US3] Show an "Unverified" badge on `apps/web/src/components/ProfileCard.vue` when the row's `emailVerified` is false, and nothing when true or absent (FR-026). Depends on T013
- [ ] T016 [US3] Document the settings status, warning, and badge in `docs/web-nav.md` (FR-017)

**Checkpoint**: Stories 1 to 3 complete

---

## Phase 6: Shared by User Stories 1 to 3, and PR 1 release

**Purpose**: the per-address throttle, the interim Google message, and the release

- [ ] T017 Add the per-address throttle as a Better Auth `hooks.before` in `packages/api/src/lib/auth.ts` on `/request-password-reset` and `/send-verification-email`: a dedicated `TokenBucketStore` from `packages/api/src/lib/rate-limit.ts` keyed by the lowercased address, "capacity 3, refilling 3 per hour", counting requests rather than sends, returning 429 with `Retry-After` and `{ error: "too_many_requests" }` (FR-012, SC-006, data-model.md, contracts/http.md). Test first in `packages/api/src/index.test.ts`: the fourth request for one address within the hour gets 429 whether or not the address has an account, and a different address is unaffected. Also make sure Better Auth's built-in per-IP limiter sees the real client IP in production: requests arrive through Cloudflare Tunnel with `CF-Connecting-IP` (see `middleware/observability.ts`), and if Better Auth finds no IP header every client shares one bucket, so 3 resets a minute would apply site-wide. Configure `advanced.ipAddress` in `createAuth` to read `CF-Connecting-IP` if its defaults do not, with a test that two different `CF-Connecting-IP` values get separate buckets on `/request-password-reset` under production rate-limit settings. Document both in `docs/server-api.md` §Rate limiting
- [ ] T018 Replace the `account_not_linked` message in `apps/web/src/lib/socialSignInError.ts` with the interim text from contracts/ui.md (sign in with your password and verify in settings, or reset the password), updating `apps/web/src/lib/socialSignInError.test.ts` first; in `packages/api/src/lib/auth.ts`, remove `google` from `accountLinking.trustedProviders` so Better Auth links a Google sign-in into an existing account only when Google reports the address verified (FR-014, research D12), and rewrite the comment above `accountLinking` to explain both gates. Test first in `packages/api/src/index.test.ts` with a stubbed Google provider (token and userinfo responses; T021 reuses the stub): a Google sign-in with `email_verified: false` for a verified local user's address is refused with `account_not_linked`, and with `email_verified: true` it signs in to that account
- [ ] T019 Run quickstart.md's automated and manual phase 1 checks, `pnpm test`, `dprint check`, and `typos`
- [ ] T020 Release: api PATCH and web PATCH, one bump commit each with a CHANGELOG entry per package convention

**Checkpoint**: PR 1 ready to open

---

## Phase 7: User Story 4 - Add Google sign-in to a password account (Priority: P3, PR 2)

**Goal**: password learners connect Google from settings, and a signed-out Google sign-in onto an unverified password account offers "That's me" or "That's not me".

**Independent Test**: connect Google from settings on an unverified account (verified afterwards, password kept); from a signed-out device, take over another unverified account with "That's not me" (old password and sessions gone).

### Tests for User Story 4

- [ ] T021 [US4] Write the end-to-end test of the refused Google callback first, in `packages/api/src/index.test.ts`, stubbing Google's token and profile responses: a Google sign-in for an unverified password account's address redirects to `/profiles?force=1&pending=<token>` instead of `?error=account_not_linked`, and a pending record exists for 10 minutes (research D7 risk, FR-021); with `email_verified: false` from Google it still redirects with `?error=account_not_linked` and writes no pending record (research D12). Then test the two routes from contracts/http.md: claim with a session links Google, keeps the password, and verifies; claim with a mismatched address is refused; takeover removes the password and every session, links Google, and verifies; takeover of a user who became verified after the pending record was written returns the same 400 and changes nothing (research D12); a used, expired, or unknown token gets the same 400 (FR-021); and linking a matching Google account through `/link-social` verifies the user (FR-018)

### Implementation for User Story 4

- [ ] T022 [US4] In `packages/api/src/lib/auth.ts`, stash the Google profile during the callback and, in a `hooks.after` on the callback, when the stashed Google `email_verified` is `true`, turn the `account_not_linked` redirect into a pending verification row `pending-google:<token>` (value: user id, Google `sub`, email; 10 minutes) and a redirect to `/profiles?force=1&pending=<token>` (owner per plan.md; research D7; data-model.md). Covered by T021
- [ ] T023 [US4] Add a `databaseHooks.account.create.after` in `packages/api/src/lib/auth.ts` that marks the user verified when a Google account is linked; this relies on T018 having removed Google from `trustedProviders`, so Better Auth only creates such rows for addresses Google verified, and `linkSocial` already enforces the same address (owner per plan.md; research D6, D12). Covered by T021
- [ ] T024 [US4] Add `POST /api/account/google/claim` (session) and `POST /api/account/google/takeover` (no session) to `packages/api/src/routes/account.ts` per contracts/http.md, consuming the pending row once with `consumeVerificationValue`; takeover refuses an already verified user with the same 400, then uses `revokeUnprovenAccountAccess`, links Google, and verifies; claim also verifies (research D7, D12). Covered by T021
- [ ] T025 [US4] In `apps/web/src/views/ProfilePickerView.vue`, handle `?pending=`: show the choice from contracts/ui.md; "That's me" opens email sign-in for that address and claims on success; "That's not me" shows the warning (whoever set the password loses access, the account may hold someone else's progress), requires confirmation, calls takeover, then starts Google sign-in again (FR-019, FR-020), and extend the settings warning from T014 to "Until you verify, anyone with access to this inbox or its Google account can take over this account." (FR-022), and afterwards shows the notice pointing to Delete all progress and Reset account (FR-023). Reuse `ConfirmDialog` for the warning. Remove the interim `account_not_linked` text from `apps/web/src/lib/socialSignInError.ts` if no longer reachable, updating its test
- [ ] T026 [P] [US4] Add "Connect Google" to `apps/web/src/views/SettingsAccountView.vue` when the account has no Google link, calling `linkSocial` through a wrapper in `apps/web/src/lib/authClient.ts`; a mismatched address shows Better Auth's refusal (FR-018, US4 scenario 3)
- [ ] T027 [US4] Document the choice screen, both routes, Connect Google, and the pending rows in `docs/server-api.md`, `docs/persistence.md`, and `docs/web-nav.md`; update the Better Auth gotchas in `CLAUDE.md` with the inferred-hook dependency (FR-017)

**Checkpoint**: Google linking and takeover work

---

## Phase 8: User Story 5 - Clear an account's contents (Priority: P3, PR 2)

**Goal**: "Reset account" beside "Delete all progress", both confirmed by typing the address.

**Independent Test**: on an account with progress, enrolments, and year settings, Reset account with the address typed leaves a fresh account whose sign-in methods still work.

### Tests for User Story 5

- [ ] T028 [P] [US5] Extend `packages/api/src/routes/account.test.ts` (next to the existing Delete all progress tests): `DELETE /api/account` requires auth, removes progress plus `user_materials`, `user_year_settings`, `material_schedules`, and `graph_snapshots`, and leaves the user, its accounts, and its sessions (FR-024)

### Implementation for User Story 5

- [ ] T029 [US5] Extend `packages/api/src/lib/reset.ts` with the full reset, reusing `deleteAccountProgress`'s engine lock and invalidation (owner per plan.md; research D8), and expose it as `DELETE /api/account` in `packages/api/src/routes/account.ts` returning the same summary shape. Covered by T028
- [ ] T030 [US5] Add a "Reset account" card to `apps/web/src/views/SettingsAccountView.vue` beside Delete all progress, reusing `TypeToConfirmDialog` with the address as `match-text` and the existing backup button, and running `resetProfileLocalData` afterwards as Delete all progress does (FR-024, FR-025, Principle VI). Add the API call in `apps/web/src/api.ts` next to the progress delete
- [ ] T031 [US5] Document `DELETE /api/account` in `docs/server-api.md` §Account data and the card in `docs/web-nav.md` (FR-017)

**Checkpoint**: Stories 4 and 5 complete

---

## Phase 9: PR 2 polish and release

- [ ] T032 Run quickstart.md's phase 2 checks, `pnpm test`, `dprint check`, and `typos`
- [ ] T033 Release: api PATCH and web PATCH, one bump commit each with a CHANGELOG entry

---

## Dependencies & Execution Order

- T001 and T002 first; T002 blocks every story.
- US1 (T003 to T007), US2 (T008 to T011), and US3 (T012 to T016) depend only on T002. T009 and T004 edit the same `createAuth` call, so run them in sequence. US3's web tasks need T013 first.
- T017 needs T004 and T009 (both paths must exist). T020 closes PR 1.
- PR 2 starts after PR 1 merges. T021 before T022 to T024. T025 needs T022 and T024. US5 is independent of US4 within PR 2.

### Parallel Opportunities

- T001 alongside T002.
- Within US1: T005 and T006 (different web files) while T004 is written.
- Within US3: T014 and T015 after T013.
- T018 after T017 (both edit `packages/api/src/lib/auth.ts`).
- US5 (T028 to T031) alongside US4.

## Parallel Example: User Story 1

```bash
Task: "Forgot-password mode in apps/web/src/components/SignInForm.vue"
Task: "Reset page in apps/web/src/views/ResetPasswordView.vue"
```

## Implementation Strategy

1. MVP: T001, T002, then User Story 1. Reset alone already fixes the worst gap.
2. Add US2 and US3, then the throttle (T017) before opening PR 1, since the reset form is public.
3. PR 2: US4 test-first because it relies on inferred Better Auth hooks, then US5.

## Notes

- Commit after each task or logical group; test before implementation where a task adds a test.
- Stop at each checkpoint to validate the story on its own.
