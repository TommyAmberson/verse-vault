# Changelog — `@verse-vault/web`

All notable changes to this package are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Released via `.github/workflows/deploy-web.yml` (Cloudflare Pages, `verse-vault-web`) on every
`version` bump in `apps/web/package.json` that lands on `master`.

## [Unreleased]

### Type-to-recite on Recitation + Ftv

* **Optional type-out box** on the front of `Recitation` and `Ftv` cards. The user can type their
  recall before flipping, or leave it blank and recite aloud — flipping with an empty box renders
  the back exactly as before, so the "say it in my head" workflow stays the default.
* **Word-level diff** replaces the canonical text on the back when the user typed something: matched
  words read normally, missing canonical words are underlined in the Again-grade red, and extra
  words the user typed get a strikethrough in the same red. Comparison is normalised — lowercased,
  punctuation stripped, whitespace collapsed — so a missing comma or "Lord" vs "LORD" doesn't read
  as an error. Fancier per-word fuzzy matching (spelling) is a follow-up.
* For `Ftv`, the textarea is pre-filled with the on-screen prefix so the user can keep typing into
  it. The prefix is sliced out of both the expected text and (greedily) the user's input before
  diffing, so keeping or deleting the prefill produces the same back-of-card — only the continuation
  gets graded.
* Internals: new `apps/web/src/lib/diff/wordDiff.ts` (LCS-based word diff), `CardPrompt.vue` owns
  the per-card `userInput` ref and resets it on card swap.

## [0.1.13] — 2026-05-26

### Added

* **Heading config split + `HeadingPassage` card render.** Settings now exposes two heading toggles:
  "Heading passage prompts" (the new per-heading `HeadingPassage` card, defaulting on) and
  "Per-verse heading prompts" (the old `VerseInHeading` card, defaulting off). Both grade the same
  `VerseHeadingBinding` test set, so the two cards share FSRS state per member; the passage card is
  the higher-signal default and the per-verse card is now opt-in for users who specifically want it.
  The API consumes the renamed `headingCard` / `headingPassageCard` fields and the web client
  forwards them through `buildMaterialConfig` to the WASM engine.
* `CardPrompt` renders the new card minimally: passage range as the ref, placeholder prompt on the
  front, heading title on the back. Verse-colour stripe stays suppressed because the card is
  anchored to a pseudo verse (`verse === 0` sentinel) — the colour mnemonic is per-verse-number and
  doesn't apply here.

### Bundled algorithm contract

* `verse-vault-core@0.2.0` — adds `CardKind::HeadingPassage`, splits the heading toggle on
  `MaterialConfig`.
* `verse-vault-wasm@0.2.0` — adds `CardKindWire::HeadingPassage`; reworks pseudo-card session
  placement so `HeadingPassage` introduces when any heading member is started and `ChapterClubList`
  when every chapter+tier member is started, with one-per-kind-per-verse capping and catch-up
  attachment for backlog cards.

## [0.1.12] — 2026-05-24

### Picker polish

* **Reauth flow pre-fills the email.** Clicking a signed-out card (or a signed-in card whose server
  token was revoked) now drops the user into the sign-in form already populated with that profile's
  address and opened directly to email-signin mode. Saves typing and signals "this is the account
  you were already using." The Add-another-profile entry stays blank.
* **Reactive profiles list.** The picker no longer fetches `listProfiles()` on mount only — the list
  lives as a shared reactive ref in `useAuth`, refreshed by every mutation (sign in, sign out,
  enter, delete, token rotation, boot reconcile). Chips reflect server-state changes without
  remounting; deleting the last card flips the picker to its empty state without manual refresh.
  `mode === 'add'` short-circuits the reactive flip so an in-flight sign-in form isn't yanked out
  from under the user.
* **Shared `StatusChip` component.** Extracted from the near-identical hand-rolled chip spans in
  `ProfileCard` (signed-in/out) and `MaterialView` (per-deck active/maintenance/paused). Three
  variants (`accent` / `warning` / `muted`) cover both call sites; `xs` / `sm` size prop preserves
  existing visual hierarchy. Next chip needed gets it for free.

## [0.1.11] — 2026-05-23

### Multi-session + reauth dialog

* **Multiple accounts on one device.** Wires Better Auth's `multiSession` plugin (server) +
  `multiSessionClient` (client). Each sign-in stacks a new session cookie alongside any existing
  ones rather than replacing them; `enterProfile` calls `multiSession.setActive` before swapping
  per-profile IDB so the API sees the right user for that profile's session. Tokens are stored on
  the registry row (`ProfileRow.sessionToken`); the picker uses them to render a "Signed in" /
  "Signed out" chip per card.
* **Per-card sign-out.** Any signed-in card's kebab now exposes Sign out. Active-card sign-out
  clears the in-memory active state and drops back to the picker; non-active sign-out just flips
  that card's chip to "Signed out" — the workspace continues uninterrupted on the active profile.
  Built on `multiSession.revoke` so other profiles' cookies stay intact.
* **Click-to-reauth on signed-out cards.** Cards without a valid token emit `reauth` instead of
  `enter`; the picker drops into the sign-in form so the user can refresh their session.
* **Reauth dialog for conflicting sessions.** When the OAuth callback or a fresh email sign-in
  returns a different user than the currently-active profile, the workspace surfaces a modal: Switch
  to the new account (becomes active; old profile remains on the device as a signed-out card) or
  Stay signed in (revoke the new token, keep the prior active profile — typically stale until the
  user re-auths). Replaces the previously-orphaned `useAuth().conflict` ref that had no consumer.
* **Boot reconciliation.** The router boot kicks off `multiSession.listDeviceSessions` and clears
  stored tokens for any registry profile whose session no longer exists server-side, so the chip
  reflects reality after expirations or remote revocations.
* New: `ConfirmDialog` reused as the reauth modal in `App.vue`.
* Modified: `lib/engine/registry.ts` (DB v1 → v2, backfills `sessionToken: null`); `useAuth.ts`
  (token capture + reconcile + accept/cancel resolvers; `signOut(profileId?)`); `lib/authClient.ts`
  (attaches `multiSessionClient`); `components/ProfileCard.vue` (chip + always-on Sign out + reauth
  event); `views/ProfilePickerView.vue` (wires the new events).

## [0.1.10] — 2026-05-23

### Profile picker UI

* **`/profiles` is the new entry point.** Replaces the single-form `SignInView`; lists every profile
  on the device as a card (avatar, name, email, last-used timestamp) and lets the user enter, sign
  out, or delete any of them. Clicking "Add another profile" reveals the existing `SignInForm`
  inline so a second account can be linked without leaving the route. The legacy `/signin` URL
  redirects here so the offline banner's existing link keeps working.
* **Workspace "Switch profile" entry.** The user-menu's Sign out button is replaced by a Switch
  profile link to `/profiles?force=1` (the `force=1` defeats the guard's auto-redirect-to-`/review`
  that fires when a signed-in user navigates to the picker by URL). Sign-out now happens from the
  per-card kebab inside the picker; this keeps all profile-lifecycle actions in one place.
* **Delete profile** path drops both the registry row and the per-profile `verse-vault-${id}` IDB
  database. If the deleted profile was the active one, in-memory engine sessions are cleared and the
  `lastActiveProfileId` pointer is unset so the picker stays put rather than auto-redirecting on
  next render.
* **Per-card "Sign out" only renders on the active card** in PR B — non-active profiles don't have a
  separate session to clear yet. Per-profile device tokens (and per-card sign-out for non-active
  profiles) arrive in a follow-up PR.
* New: `apps/web/src/views/ProfilePickerView.vue`, `components/ProfileCard.vue`,
  `components/ConfirmDialog.vue`.
* Modified: `useAuth.ts` exposes `enterProfile` + `deleteProfile`; `router/index.ts` registers
  `/profiles` (and redirects `/signin` → `/profiles`); `App.vue` swaps Sign out for Switch profile.
* Deleted: `apps/web/src/views/SignInView.vue` (functionality absorbed into `ProfilePickerView`).

## [0.1.9] — 2026-05-22

### Offline-first boot + profiles

* **Profiles are now a first-class concept.** Each signed-in account on a device gets its own
  IndexedDB database (`verse-vault-${userId}`). A shared `verse-vault-registry` DB tracks the list
  of known profiles + a `lastActiveProfileId` pointer. The router boot reads the registry (a fast
  local IDB read) instead of awaiting `authClient.getSession()` — workspace renders immediately on
  launch, even when the API is unreachable. The previously-blank Tauri-shell boot path now works
  offline.
* **Online / offline state is profile-scoped.** A new offline banner ("Offline — sign in to sync N
  grades") sits between the header and the router-view, visible only when the most recent sync
  attempt failed. Clicking routes to /signin with the current path as `redirect`.
* **Sign-out semantics now preserve the profile.** Sign-out clears the session cookie and the
  `lastActiveProfileId` pointer, but the per-profile DB stays intact. Next sign-in as the same user
  resumes their cached data; cross-account sign-in starts fresh.
* **Migration:** the first sign-in after this lands copies the legacy un-namespaced `verse-vault` DB
  into the newly-created profile DB, then deletes the legacy. One-shot; subsequent sign-ins find no
  legacy DB and skip.
* New: `apps/web/src/lib/engine/registry.ts`, `migrate-legacy.ts`, `components/OfflineBanner.vue`.
* Modified: `useAuth.ts` exposes `activeProfile`, `isOnline`, `conflict`, `signInComplete`,
  `markOnline`; `persistence.ts` is parameterised by the active profile; `router/index.ts` guard is
  cache-first (no awaited network call); `App.vue` reads identity from `activeProfile`.

The picker UI (multi-profile cards with sign-out and delete affordances) is deferred to a follow-up
PR; this PR keeps the existing email/password form as the entry point for unauth'd users.

## [0.1.8] — 2026-05-22

### Added

* **Tauri v2 desktop shell.** New `apps/web/src-tauri/` Cargo project wraps the existing Vue + WASM
  bundle as a native desktop app (mac / linux / windows). Layout mirrors the qzr-sheet pattern:
  `src-tauri/` is a sibling to `src/` and `public/` so the same `package.json` drives both
  `pnpm dev` (web) and `pnpm tauri dev` (desktop). Crate is intentionally outside the root Cargo
  workspace (empty `[workspace]` table detaches it) so Tauri's transitive deps don't slow
  `cargo check` for the algorithm crates.
* Window config uses `useHttpsScheme: true` so the in-app origin is `https://tauri.localhost`
  (Windows / Edge WebView2) and `tauri://localhost` (macOS / Linux / WebKit). Both the API CORS
  allowlist and Better Auth `trustedOrigins` accept the two origins. No `fs`/`dialog` plugins — the
  app is fully self-contained in the webview (IndexedDB + fetch); default capabilities are
  core-only.
* `.github/workflows/release-tauri.yml` builds matrix on linux/windows/macos when
  `apps/web/src-tauri/tauri.conf.json` `version` field bumps; uploads installers to a draft GitHub
  release that flips to published after all three platforms upload cleanly. No code signing (Apple
  Developer ID and Windows EV cert are paperwork-blocked); unsigned builds work for
  self-distribution.
* Icons generated via `pnpm tauri icon` from a 1024×1024 PNG source; SVG master committed alongside
  as `icon.svg` so future re-rasterisation stays faithful.
* **Stale-merge confirmation modal.** New `StaleMergeModal.vue` component reads
  `useEngine().staleSummary` and renders Sync / Discard / Cancel. Rendered as an overlay from
  ReviewView and MemorizeView when the server flags a batch as stale. The composable surface
  (`confirmMerge`, `discardStale`) existed in 0.1.7 but no view consumed it; flushes for affected
  materials silently no-op'd via the `staleGate` until this UI shipped.
* **MAUA attribution footer.** Site-wide footer in `App.vue` carrying the canonical NKJV citation
  and a `https://api.bible` link, visible on every route. Required by the API.Bible Starter-plan
  terms and previously only present in `NOTICE.md` (not surfaced to end users).
* **Offline-mode toggle in MaterialView.** New "Offline study" section per year drives the
  `PATCH /api/materials/:id/offline-mode` flag + the bulk-renders download into IDB. Flipping on
  fetches `GET /api/materials/:id/renders` once and seeds the `renders` store via the new
  `bulkPutRenders` helper; flipping off clears the store. UX surfaces "Refreshed N days ago" off
  IDB's newest `fetchedAt`. Pre-existing lazy render cache (one entry per viewed card) keeps working
  unchanged for users who don't opt in. Matches the architecture's MAUA-compliant split:
  bulk-extraction only happens at explicit user request.
* `setOfflineMode` + `getMaterialRenders` on the API client; `MaterialStatus` + `MaterialRender`
  types exposing the new server payloads.
* `bulkPutRenders` + `newestRenderFetchedAt` exports in `persistence.ts`. The bulk-put replaces
  every existing entry for the material in one transaction so a partial lazy-cache subset can't
  shadow the fresh batch.

### Refactored

* `apps/web/src/lib/engine/persistence.ts` centralises IDB store names in a single `STORE` const +
  `BY_MATERIAL_ID_INDEX` constant. Inline string literals across the helper functions are typo-prone
  — TypeScript catches them at the type layer now. No emitted-string change.

### Performance

* `MaterialView.onSave` no longer invalidates the cached engine + render cache when only
  `lessonBatchSize` (a session-size knob the engine doesn't consume) changed. Previously every
  settings save wiped a full deck's lazy-cached renders.

### Known limitations

* **Google OAuth in the Tauri shell is untested in this PR.** The server-side wiring matches
  qzr-sheet's known-working pattern (CORS + Better Auth `trustedOrigins` for the Tauri origins; no
  special `redirectURI` override — the default cross-origin cookie bounce through the API's own
  callback URL handles it). `useHttpsScheme: true` is what makes the session cookie eligible to be
  sent from the Tauri window (Secure cookies require an HTTPS-equivalent context). Real smoke-test
  will land alongside the first user actually signing in via Google from the desktop app; if it
  doesn't work, the follow-up is either `tauri-plugin-deep-link` or a separate Google OAuth client
  with a Tauri callback URI registered. Email + password works today.
* Code signing for macOS and Windows installers is unwired. Builds work; the installers trigger
  Gatekeeper / SmartScreen warnings until Developer ID / EV certs are added to CI secrets.

### Bundled algorithm contract

* `verse-vault-core@0.1.0` — unchanged (no core changes)
* `verse-vault-wasm@0.1.2` — adds `all_card_renders()` used by the API's bulk renders endpoint

## [0.1.7] — 2026-05-21

### Added

* **Fat-client engine.** ReviewView, MemorizeView, MaterialView, and StatsView now drive the WASM
  engine locally. Each grade runs `engine.replay_event` in-browser and queues an event to IndexedDB;
  the background flush ships them to `POST /api/sync/:materialId/events` on a 5 s debounce + on tab
  hide. No more network round-trip per card. Per-card render output caches in IDB (MAUA-compliant
  30-day TTL); the engine sources next-card decisions locally so review feels instant.
* `verse-vault-wasm-web` workspace package (wasm-pack `--target bundler` output) — same Rust source
  as the API's nodejs target, different JS shim. Vite emits the .wasm asset (~117 KB gzipped) as
  part of the build.
* `useEngine` composable + `engineStore` module-singleton owning per-material `WasmEngine` instances
  across navigations. Multi-material capable for MemorizeView's cross-year sessions.
* `getSyncState` + `postSyncEvents` methods on the API client wrapping the new server endpoints.
* `MaterialConfig` (newScope, reviewScope, clubCardScope, chapterListScope, headings, ftv) now
  threads through to the client engine; `MaterialView.onSave` invalidates the cached engine + render
  cache for the affected material so the next view visit rebuilds with fresh settings.

### Fixed

* `StatsView` no longer hardcodes `MATERIAL_ID = 'nkjv-cor'` — fetches stats per enrolled year via
  `getYears` and renders one card per year, sorted by total reviews. Single-year failures degrade
  gracefully via `Promise.allSettled` rather than blanking the whole page.
* Stale-merge `needsConfirm` responses no longer trigger an unbounded re-POST loop. The
  `engineStore` module now tracks a per-material `staleGate`; flushes for gated materials no-op
  until a `confirmMerge: true` flush succeeds or `clearStaleGate(materialId)` is called by the
  discard path.
* Render cache skips IDB writes when the server returns `composed: null` (the BIBLE_API_KEY-unset
  fallback path), so a misconfigured first request can't wedge the cache with empty composed HTML
  for the full 30-day TTL.

### Build

* `tools/build-wasm-web.sh` runs `wasm-pack build crates/wasm --target bundler --out-dir pkg-web`
  and renames the output package to `verse-vault-wasm-web` so both bundler + nodejs targets can
  coexist in the pnpm workspace.
* `vite-plugin-wasm` + `vite-plugin-top-level-await` handle the bundler-target import; build target
  bumped to `es2022` to compile the wasm-bindgen TLA shim cleanly.
* `.github/workflows/deploy-web.yml` installs the Rust toolchain + wasm-pack before `pnpm install`
  so the workspace `verse-vault-wasm-web` package exists when pnpm resolves the apps/web dependency.

### Documentation

* New top-level `NOTICE.md` carries the NKJV citation in the Starter-plan canonical form + the
  API.Bible attribution surface. `README.md` gains a "Third-party content" section pointing at it.
* MAUA URL fixes — see `packages/api/CHANGELOG.md` 0.1.8 for the matching server-side cleanup.

### Bundled algorithm contract

* `verse-vault-core@0.1.0` — unchanged
* `verse-vault-wasm@0.1.0` / `verse-vault-wasm-web@0.1.0` — same crate, two pkg targets

## [0.1.6] — 2026-05-21

### Fixed

* Production-only URL plumbing audit. Two issues:
  1. **API client double-pathed every request.** `VITE_API_BASE` was `/vv/api`, but every path
     passed to the api client already starts with `/api/` — so the final URLs became
     `/vv/api/api/cards/...` and 404'd the entire (non-auth) API surface in production. Confirmed by
     curl: `/vv/api/api/me` → 404, `/vv/api/me` → 401.
  2. **Better Auth client's `withPath` skips the `/api/auth` auto-append** when the baseURL has any
     path component (and `/vv` counts), so route calls were landing at `/vv/sign-up/email` (405)
     instead of `/vv/api/auth/sign-up/email`.

  Fix: `VITE_API_BASE` is now the subpath-only prefix (`/vv`) without `/api`. The api client adds
  `/api/...` itself, and `useAuth.ts` adds `/api/auth` explicitly for Better Auth.

## [0.1.5] — 2026-05-21

### Fixed

* 0.1.4 stripped `/api` off `VITE_API_BASE` to derive the Better Auth client `baseURL`, yielding
  `/vv` in production. Better Auth's `createAuthClient` validates that string with `new URL(...)`,
  which rejects relative paths (`Invalid base URL: /vv`) and the SPA crashed on first render.
  Resolve the relative path against `window.location.origin` before passing it in.

## [0.1.4] — 2026-05-20

### Fixed

* Better Auth client's `baseURL` came from `VITE_API_URL` (legacy env var) and fell back to
  `http://localhost:3000` in production because CI only sets `VITE_API_BASE`. The deployed SPA was
  therefore calling `localhost` for every auth request. Switched to deriving the auth base from
  `VITE_API_BASE` (the same env var the API client reads) by stripping the trailing `/api`.

## [0.1.3] — 2026-05-20

### Fixed

* CI: dropped `cloudflare/wrangler-action@v3` (its self-install path runs `pnpm add wrangler@<v>` at
  the workspace root, which pnpm v10 rejects without `-w`). Now publishes via
  `pnpm dlx wrangler@3 pages deploy ...` directly. 0.1.2 never reached production for the same
  family of pnpm-v10 CI breakage; 0.1.3 is the first successful deploy.

## [0.1.2] — 2026-05-20

### Fixed

* CI: `pnpm/action-setup@v4` errored on redundant version pin (both `with: version: 10` and
  `package.json`'s `packageManager: pnpm@10.7.0`). Dropped the `with` arg; 0.1.1 never reached
  production because of this, so 0.1.2 is the first successful deploy.

## [0.1.1] — 2026-05-20

### Added

* First production deploy to Cloudflare Pages.
* Vue 3 thin client: review, memorize, stats, material, sign-in views.
* Better Auth integration (email/password + Google OAuth via `authClient`).
* Subpath-aware build via `VITE_BASE_PATH` + `VITE_API_BASE` env vars.
* `_redirects` SPA fallback for CF Pages.
