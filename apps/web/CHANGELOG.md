# Changelog — `@verse-vault/web`

All notable changes to this package are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Released via `.github/workflows/deploy-web.yml` (Cloudflare Pages, `verse-vault-web`) on every
`version` bump in `apps/web/package.json` that lands on `master`.

## [Unreleased]

## [0.9.5] — 2026-07-17

PATCH — engine-session lifecycle hardening + boot refactor. Client-only; no server or wire change.

### Bundled algorithm contract

Unchanged from [0.9.4]:

* `verse-vault-core@0.7.1`
* `verse-vault-wasm@0.7.1`

### Fixed

* Concurrent same-material engine loads (e.g. navigating /memorize → /review while the first init is
  still in flight) no longer build and leak a second WASM engine (#114).
* Discarding a stale-merge batch mid-session no longer rebuilds the engine with all clubs enabled at
  the legacy retention — the rebuild reuses the session's cached per-club config + schedule (#113).
* Two materials going stale in one flush no longer wedge the second: stale-merge prompts queue per
  material and re-surface after each confirm/discard instead of the last writer overwriting the slot
  (#112).

### Changed

* Extracted the duplicated multi-year engine boot into `useEngine.initEligibleYears`, routed the
  badge + boot through a shared schedule cache, and folded the enabled-club check into
  `lib/clubs.ts` (#115). MemorizeView now degrades a failed schedule fetch to pure-Sequential rather
  than failing the whole session.

## [0.9.4] — 2026-07-15

PATCH — ships the #107 scheduling fixes by bundling the new algorithm contract. No web-side code
change.

### Bundled algorithm contract

* `verse-vault-core@0.7.1` — relearn-lane per-test coldness gate (#107 A/B) and cooldown-aware
  `due_review_count` / `due_verse_count` (#107 C).
* `verse-vault-wasm@0.7.1` — no wire-format change.

### Fixed

* Grading a card Again no longer re-serves the same card (or an overlapping sibling) seconds later —
  the relearning lane now waits out the 30-minute sibling cooldown before re-drilling a lapse.
* The client engine's due counts now exclude cooldown-masked cards, so "N to review" stops
  advertising reviews the session refuses to serve right after a session ("1 to review" → "Session
  complete").

## [0.9.3] — 2026-07-15

PATCH — the remaining tail of #107 symptom C. No wire-format change; no contract crate bump.

### Bundled algorithm contract

* `verse-vault-core@0.7.0` — unchanged.
* `verse-vault-wasm@0.7.0` — unchanged.

### Fixed

* `/review` served only the **first** enrolled year with a review club enabled, while the home-page
  badge sums due counts across **every** year. A first-matched year with an empty local queue (e.g.
  a legacy year with test states but no graduations in the event log, so every card is still `New`
  client-side) rendered "Session complete" even when a later year held the entire due queue. The
  session now boots an engine per enrolled year (parallel init, mirroring MemorizeView) and drains
  each year's queue in `/years` order, routing grades to the engine that produced the card.

Diagnosed live: `nkjv-cor` (4784 test states, 0 graduations — queue always empty) matched first and
masked `nkjv-john`'s ~40 due cards. The 0.9.2 config-shape fix was real but didn't cover this path.
Known follow-up: legacy years with test states but no graduation log entries are unreviewable on
every client until graduations are backfilled server-side.

## [0.9.2] — 2026-07-14

PATCH — fix for #107 symptom C (client badge/review-queue divergence from the server). No
wire-format change; no contract crate bump.

### Bundled algorithm contract

* `verse-vault-core@0.7.0` — unchanged.
* `verse-vault-wasm@0.7.0` — unchanged.

### Fixed

* The browser WASM engine was being constructed with the legacy flat `WireMaterialConfig` shape
  (`new_scope`, `review_scope`), while the server had moved to the per-club shape in Phase 1. Rust's
  `MaterialConfigRaw` still accepted the legacy fields, but that path derived per-club `enabled` +
  `desiredRetention` from the scope-ladder fallback instead of the user's actual per-club
  configuration. That divergence is the leading suspect for #107 symptom C ("35 to review" server
  badge vs "session complete" from the client engine).
  * `apps/web/src/lib/engine/types.ts`: `WireMaterialConfig` now matches the per-club JSON blob the
    API's `readMaterialConfigJson` emits (per-club `memorize`, `review`, `moveToNext`).
  * `apps/web/src/views/ReviewView.vue`, `apps/web/src/views/MemorizeView.vue`: enrolment gates read
    per-club `memorize`/`review` `enabled` maps; the engine constructor receives `y.perClub` instead
    of `y.settings`; `lessonBatchSize` reads off `y.perClub`.

#107 symptoms A (relearn lane bypass letting a just-lapsed card resurface immediately) and B
(heading re-served) are Rust-core follow-ups and remain open.

## [0.9.1] — 2026-07-14

PATCH — deployability fix. 0.9.0 landed on master with 11 `vue-tsc` type errors that broke the web
deploy pipeline (`type-check` gate in `.github/workflows/deploy-web.yml`), so the corresponding CF
Pages build never shipped. This release fixes the type errors and adds a PR-CI `ts` job so the same
slip can't happen again.

### Bundled algorithm contract

* `verse-vault-core@0.7.0` — unchanged.
* `verse-vault-wasm@0.7.0` — unchanged.

### Fixed

* `apps/web/src/lib/badges.ts`: `currentWeekIndex` and `cumulativeThroughWeek` now guard array
  indexing under `noUncheckedIndexedAccess`; the badge cumulative sum skips the `'full'` tier
  explicitly, since schedules only carry per-week verse lists for `club150` / `club300`.
* `apps/web/src/lib/schedule.ts`: `fullDayName` / `monthName` assert the constant-array lookups are
  defined.
* `apps/web/src/views/ScheduleEditorView.vue`: hoist `selection.value` into a local const so the
  discriminated-union narrowing (`kind === 'meet'`) survives across the closure boundary in
  `selectedMeet` and `updateMeetField`.
* `apps/web/src/views/SettingsMaterialsView.vue`, `apps/web/src/views/SettingsView.vue`: assert
  bounded array lookups (`CLUBS[idx + 1]`, `GATE_FIELDS[idx]`, `SECTIONS[0]`).

## [0.9.0] — 2026-07-13

Passage picker redesign (spec `docs/superpowers/specs/2026-07-13-passage-picker-redesign.md`). MINOR
— visible UX change on `/schedule/:materialId` edit mode; no wire-format change.

### Bundled algorithm contract

* `verse-vault-core@0.7.0` — unchanged.
* `verse-vault-wasm@0.7.0` — unchanged.

### Editor

* Passage editor: four labelled dropdowns → one inline horizontal row reading
  `Book | Ch. | Start — End`. Wraps at container widths below 520px (Book on its own row).
* Multi-passage weeks: fieldset border + PASSAGE legend gone; blocks stack with a small `Passage N`
  caption + `× remove` and a hairline `border-top` between siblings. Solo blocks render bare.
* Club summary: moved out of every block into a single week-level row below all blocks.
  Single-passage weeks keep the flat pill list; multi-passage weeks nest a `Ch N:` sub-row per
  passage under each club label. Counts stay cumulative (150 / 300 / Full).
* Review-week toggle removed. Review is now derived: `blocks.length === 0`. Removing the sole
  passage collapses the wk-form to an italic dashed "This is a review week" message +
  `+ Add a passage` button; adding a passage clears the state.

## [0.8.1] — 2026-07-12

Phase 7 of the schedule editor redesign — polish. PATCH — no observable API change, keyboard +
focus + animation refinements only.

### Bundled algorithm contract

* `verse-vault-core@0.7.0` — unchanged.
* `verse-vault-wasm@0.7.0` — unchanged.

### Editor

* **Esc dismisses the expanded form.** A window-level `keydown` listener clears `selection` when Esc
  fires in edit mode, collapsing the inline form.
* **First input autofocuses on select.** After a week or meet row is picked, a `nextTick` watcher
  focuses the first input in the paired `.wk-form` / `.meet-form` so Tab / Enter work without a
  click.
* **Slide-in on expand.** The form animates in with a 140ms opacity + scaleY fade; disabled under
  `prefers-reduced-motion`.
* Auto-scroll to the current week now targets the `.sched .wk.is-current` selector — the pre-
  phase-5 selector (`.week-row.is-current`) no longer exists.

## [0.8.0] — 2026-07-11

Phase 6 of the schedule editor redesign — multi-passage editor. MINOR — the schedule editor now
iterates every passage block on the selected week; NT-Survey-style compound weeks (`|` weeks) are
first-class in view and edit alike.

### Bundled algorithm contract

* `verse-vault-core@0.7.0` — MAJOR. Consumes `ScheduleWeek.blocks[]` natively.
* `verse-vault-wasm@0.7.0` — MAJOR. Normalises v1 wire form into `blocks[]` in `parse_schedule`
  before constructing the engine.

### Editor

* The per-week inline form renders one `<fieldset class="passage">` + `<fieldset class="verses">`
  pair per block. When more than one block exists each `<legend>` numbers the block and shows a
  remove-passage `×` button.
* **+ Add a passage** at the bottom of the form appends a fresh block. **× remove** on a passage
  legend removes it (guarded to keep at least one block).
* `verseInputs` state is now a `BlockVerseMirror[]` indexed by block idx; the watcher re-seeds it
  whenever the selected week's block shape changes (selection, review toggle, add / remove passage).

### View

Multi-passage weeks already rendered under one shared date in the view-mode `.sched` (phases 3, 5);
this release makes them editable end-to-end.

Phase 5 of the schedule editor redesign — expand-in-place editor. MINOR — visible UX change on
`/schedule/:materialId`: edit mode no longer opens a side pane, so nothing overflows at any
container width.

### Bundled algorithm contract

* `verse-vault-core@0.6.0` — unchanged.
* `verse-vault-wasm@0.6.0` — unchanged.

### Editor

* Clicking a week or meet in edit mode expands the row inline. The form sits between rows in the
  same responsive `.sched` container, with an accent left rule + tinted background so the expansion
  reads at every regime (Cards / Condensed / Ledger).
* Legacy `<table class="schedule-table">` and the `<aside class="detail">` side pane are removed
  along with their CSS. Edit mode now shares the exact DOM/CSS of view mode with a small extra form
  block per selected row.
* Add-week / Add-meet buttons live at the bottom of the body in edit mode.

### Deferred (phase 6 alongside the Rust/WASM multi-passage contract bump)

* Chip-based verse-number editor (spec §3.5 "Club 150 / 300 chips"). Today the form still uses the
  comma-parsed text input on blur.
* Per-block add/remove-passage affordance for compound weeks. Bundled schedules ship one passage per
  week, so this doesn't gate today's UX; multi-passage editing lands with phase 6.

## [0.6.0] — 2026-07-11

Phase 3 of the schedule editor redesign — view-mode DOM is now the responsive `.sched`
container-query layout from spec §6. MINOR — visible UI change on `/schedule/:materialId` in view
mode; edit mode still shows the legacy table + detail pane until the spec's phase 5 replaces it with
an expand-in-place editor.

### Bundled algorithm contract

* `verse-vault-core@0.6.0` — unchanged.
* `verse-vault-wasm@0.6.0` — unchanged.

### Responsive view

Three regimes off the `.sched` wrapper's own width (container-query, not viewport):

* **Cards** (< 520px) — each week a self-contained card; pill verse numbers.
* **Condensed** (520–789px) — narrow date rail on the left, passage + pill verses stacked to its
  right; date spans every child row via `--wk-rows`.
* **Ledger** (≥ 790px) — the printable 4-column `DATE · PASSAGE · CLUB 150 · CLUB 300` ledger with
  comma-list verses (`::after ", "`); multi-passage weeks stack blocks under one date via
  `--wk-blocks`.

Verse-number `<span>` elements are the same in every regime; only the pill styling and the comma
`::after` selector differ. Review weeks render "Review" in the passage slot; meet rows become tinted
full-width bands at every width.

### Editor

Edit mode retains the legacy table + right-side detail pane. Phase 5 rewrites this into the
expand-in-place editor.

## [0.5.0] — 2026-07-11

Phase 2 of the schedule editor redesign — data model migration. MINOR — the persisted wire form is
unchanged (bundled JSONs and existing user rows stay v1) so the change isn't user-visible, but the
in-memory `Schedule` shape breaks previous consumers and warrants a versioned release.

### Bundled algorithm contract

* `verse-vault-core@0.6.0` — unchanged.
* `verse-vault-wasm@0.6.0` — unchanged.

### Changed

* `ScheduleWeek` now carries `blocks: PassageBlock[]` (empty on review weeks, length 1 on today's
  normal weeks, length ≥2 reserved for future NT-Survey-style compound weeks) instead of the flat
  `passage` + `verses` fields. `PassageBlock` = `{ passage, verses }`.
* New `migrateSchedule(raw)` normalises v1 wire payloads (bundled schedule JSONs, pre-migration user
  rows) into the v2 in-memory shape at read time — the API still emits v1, and the client converges
  on v2 before any consumer sees it.
* `verseCountsForWeek` sums across every block; badge math (`badges.ts`) does the same.
* `cloneSchedule` unchanged (JSON round-trip handles nested `blocks[]` uniformly).

### Editor

* `ScheduleEditorView.vue` reads/writes via `blocks[0]` — one passage per week, matching current
  bundled schedules. Multi-passage editing lands in the redesign's phase 3 view rewrite.

## [0.4.0] — 2026-06-17

Phase 3 — the schedule editor at `/schedule/<materialId>`. MINOR — additive UI surface on top of the
Phase 1 schedule data model and API, no engine or wire-format change. Closes the Phase 2 spec
deferral of the "Edit schedule →" link on the per-material card. Bundles tighter Meet validation on
the API as part of the same train (also additive, doesn't bump the API contract).

### Bundled algorithm contract

* `verse-vault-core@0.6.0` — unchanged.
* `verse-vault-wasm@0.6.0` — unchanged.

### Schedule editor

New `/schedule/:materialId` route mounted under the existing router. The editor:

* Loads via `api.getSchedule`, holds two refs (`saved` and `draft` — a `structuredClone` of saved
  that the user mutates), and a `mode: 'view' | 'edit'` switch.
* Gates Save behind a `JSON.stringify` dirty-check; Discard reclones saved into draft and returns to
  view mode.
* Guards nav-away via both `onBeforeRouteLeave` (in-app) and `beforeunload` (tab close / refresh /
  external nav) — the SPA router doesn't fire `beforeunload` on its own and `beforeunload` doesn't
  fire on in-app nav, so both are needed.

Left pane / top stack: a chronologically interleaved timeline of weeks and meets. Items sort by date
with weeks ahead of meets on ties (practice precedes the weekend). Weeks show date, passage label,
per-tier verse counts; meets show as italicized rows with a ⛺ tag and location.

Right pane / bottom stack: detail editor for the selected item.

* **Per-week editor.** Review-week toggle. Passage editor (book / chapter / start verse / end
  verse). Per-tier verse-number inputs — comma- or space-separated text, parsed on blur via
  `parseVerseList`, normalized (sorted) on commit. Invalid tokens surface an inline error and leave
  the draft untouched. Remove-this-week button. Add-a-week affordance below the timeline; new weeks
  default to the practice cycle (7 days) after the last existing week.
* **Per-meet editor.** Name, start/end dates, location. Inline endDate-before-startDate hint (soft
  warning; server-side `validateSchedule` is the hard gate on save). Add-a-meet affordance next to
  add-a-week; new meets get a `slugifyMeetId`-derived stable id so the chain UI's `move_to_next`
  gates referencing the meet survive renames.

Top-level controls.

* **Meeting-day picker** (edit mode only). Bound to `meetingDayOfWeek`; changes run
  `applyMeetingDayShift` from `lib/schedule.ts` to translate every week's date by the signed delta.
  Meets stay on their own dates per the no-per-week-override design.
* **Reset to default** (view mode only, in the header). `ConfirmDialog`-gated; on confirm fires
  `DELETE /api/materials/:id/schedule`, banner reflects the response's `fallbackToBundled` flag.

`/settings/materials` gets the "Edit schedule →" RouterLink the Phase 2 spec deferred, rendered next
to the title for every material so it's discoverable without scrolling past the chain UI. The
editor's empty-state path keeps schedule-less decks from dead-ending.

### Library helpers + canonical types

New `apps/web/src/lib/schedule.ts` is the source of truth for the editor:

* Canonical TS types (`Schedule`, `ScheduleWeek`, `ScheduleMeet`, `SchedulePassage`, `DayOfWeek`)
  mirroring the on-disk JSON and the API's `SchedulePayload`. `api.ts` re-exports `Schedule` and now
  types `getSchedule`/`putSchedule` against the parsed shape.
* Pure data-mutating helpers — `applyMeetingDayShift`, `addWeekAt`, `removeWeekAt`, `addMeet`,
  `updateMeet`, `removeMeet`, `slugifyMeetId`, `cloneSchedule`. Used by the editor for every draft
  mutation.
* Display + arithmetic primitives — `shiftDate`, `formatPassage`, `verseCountsForWeek`,
  `parseVerseList`, `formatVerseList`.

`lib/badges.ts` drops its inline `Schedule`/`ScheduleWeek` interfaces and imports the canonical pair
— a drift risk surfaced in the Phase 2 simplify pass.

## [0.3.0] — 2026-06-15

Phase 2 of the schedules + per-club settings rework. MINOR — the engine boot paths swap onto the
`verse-vault-wasm@0.6.0` constructor signature (schedule arg in, `desired_retention` arg out), the
`/settings` page picks up the spec's three-section IA with the chain UI replacing the legacy scope
ladder, and the Memorize tab badge reads the bundled schedule. No state-shape break for end users;
the IDB cache rebuilds against the new engine signature on first load after deploy.

### Bundled algorithm contract

* `verse-vault-core@0.6.0` — per-club `MaterialConfig`, two-phase canonical-order memorize fill,
  per-verse target retention. Shipped with API 0.1.28.
* `verse-vault-wasm@0.6.0` — `WasmEngine` constructor takes `schedule_json`, drops
  `desired_retention`. `memorize_session_v2(limit, now_secs)` is the new fill entry point. Shipped
  with API 0.1.28.

### Engine boot wires up schedule + per-club config

`engineLoader.createEngine` now calls
`new WasmEngine(materialData, materialConfig, schedule, testStates, BigInt(nowSecs))`, mirroring the
wasm@0.6.0 signature. `engineStore.loadEngine` takes the schedule alongside the per-material config
and threads it through every code path that builds or rebuilds the engine — initial load,
post-rebuild after sync, refetchSyncState. `useEngine.init` gains an optional `schedule` parameter
(defaults to `''` so callers that don't have one collapse to the pre-Phase-1 Sequential behaviour).
`memorizeSession` switches to `memorize_session_v2` and passes `now_secs` so Phase 1 of the fill can
read the schedule.

`ReviewView` and `MemorizeView` fetch the schedule via `api.getSchedule(materialId)` before calling
`engine.init` so the engine always boots with the user's authoritative schedule (or the bundled
default, or `''` when neither exists).

### Per-club settings + API client

New TypeScript types in `api.ts` for the per-club shape: `Club`, `CatchUp`, `MoveToNextGate`,
`ClubMemorizeConfig`, `ClubReviewConfig`, `MoveToNextConfig`, `PerClubYearSettings`. New `ApiClient`
methods:

* `updateYearSettingsPerClub(materialId, settings)` — POSTs the per-club shape to
  `/api/years/:id/settings`. Symmetric to the legacy `updateYearSettings` for the new chain UI.
* `getSchedule(materialId)` / `putSchedule(materialId, schedule)` / `deleteSchedule(materialId)` —
  wrappers around `/api/materials/:id/schedule`. `getSchedule` normalises the server's
  `{ schedule: null }` envelope to a plain `null` so callers can branch on truthiness.

`YearView.perClub: PerClubYearSettings` mirrors the new server field — the chain UI reads it for
round-trip-safe loads.

### Settings page: three-section IA (Account / Preferences / Materials)

`/settings` is now a section host with a left rail (desktop) / horizontal scrolling chips (mobile)
and child routes:

* `/settings/account` — Export my data, Import data, Delete all progress. Closes [#92][issue-92] by
  migrating the three account-level actions out of `ProfilePickerView`'s profile-card kebab (which
  now only carries Sign out + Delete profile). `AppAvatar` gains an "Account" item that deep-links
  into the section. `/profiles` goes back to being purely sign-in plus multi-profile switching.
* `/settings/preferences` — placeholder shell. Empty at launch per the spec.
* `/settings/materials` — the per-material card, default route. Carries the chain UI for "What to
  memorize" (per-club Enable + Catch-up dropdown, indented dashed gate rows between flanking enabled
  clubs carrying the Move-to-next-club selector) and per-club "What to review" cards with individual
  retention sliders (50–90%). The material-wide retention slider is gone; per-club status chips
  (Active / Maintenance / Paused) derive from the user's edits in real time. Card kinds, Offline
  study, and Session sections unchanged. Saves call `api.updateYearSettingsPerClub`.

### Schedule-aware Memorize tab badge

The nav-bar Memorize pill switches from a flat sum of every year's `newCardCount` to a
schedule-aware count. Per-year contribution:

* No memorize club enabled → 0.
* No schedule → `newCardCount` (pre-Phase-2 fallback for decks without a published schedule).
* Schedule present → `min(newCardCount, cumulative_through_current_week)` where `cumulative` is
  summed across enabled clubs' tiers in weeks [0, current_week]. Caps the badge at this week's plan
  when behind; falls back to `newCardCount` when caught up with leftover.

Math lives in `lib/badges.ts` so it's swap-out-ready when a future API surface exposes per-club
graduated counts and the v1 approximation can be replaced by the spec's exact formula.

[issue-92]: https://github.com/tommyamberson/verse-vault/issues/92

## [0.2.0] — 2026-06-12

MINOR bump for the nav redesign (identity popover, mobile bottom tab bar, route renames). Also packs
the pass-1 + pass-2 correctness sweeps from the same train: engine-store IDB write races,
retention-slider plumb-through, discardStale resets to server view, the rate-limited vs offline
distinction, and the OfflineBanner click that finally reaches the picker.

### Bundled algorithm contract

* `verse-vault-core@0.5.1` — `ftv_words > 0` floor on FTV emission + retrievability-blend `elapsed`
  floor that stops same-instant sub-updates from collapsing stability.
* `verse-vault-wasm@0.5.1` — `memorize_session` gates all three loops (verse-anchor, HP/CCL,
  conditional orphan) against the same `memorize_active_verses` HashSet, so Maintenance-tier verses
  no longer leak into the queue via any path.

### Correctness sweep on engine-store + memorize input

Four real bugs surfaced by an exhaustive review pass. Each was independently confirmed by tracing
the IDB write path or the keyboard-input path under the relevant trigger.

* **Concurrent graduations dropped ids.** `persistLocalGraduation` was doing `await getSnapshot()` →
  mutate → `await putSnapshot()` with no serialisation. `MemorizeView`'s
  `Promise.all([submitGraduation(...), ...conditionalCardIds.map(submitCardGraduation)])` fired
  multiple concurrent calls; every one read the same pre-mutation snapshot, each appended only its
  own id, the last `putSnapshot` overwrote the others. The next page-load `loadEngine` then
  graduated only the surviving id; every other graduation silently regressed to `New` and reappeared
  in the memorize queue. Per-`materialId` `persistGraduationChains` map now serialises the reads +
  writes.
* **409 retry wedged on stale `snapshotVersion`.** Queued events bake the local `snapshotVersion` in
  at queue time. On a 409 the catch arm refetched the live snapshot but didn't rewrite the queue, so
  the next flush re-sent the same rows with the stale version and the server 409'd again. New
  `idb.rewriteQueuedSnapshotVersion(materialId, ...)` runs after `refetchSyncState`, so the queued
  events carry the upgraded version on the next attempt.
* **Server-side rebuild dropped graduation state.** When `flush` got back `rebuilt: true`, the
  client `.free()`'d the engine and rebuilt it from `snapshot.materialData + response.testStates`
  but skipped `applyGraduations(...)`. Graduated verses leaked back into the New pool and next-card
  selection ignored prior graduations until a full page reload re-entered `loadEngine`. `loadEngine`
  and `refetchSyncState` both apply graduations after `createEngine`; this path now matches.
* **Profile switch leaked cross-profile writes.** `clearAllSessions` was synchronous and just
  cleared its maps. An in-flight `doFlush` for profile A kept running and its response handler ran
  `await idb.replaceAllTestStates(...)` AFTER `enterProfile(B)` had swapped the active IDB — writing
  profile A's testStates into profile B's IDB. `clearAllSessions` is now async and awaits every
  in-flight flush + every per-`materialId` persistGraduation chain (settled, not resolved, so a
  single rejection doesn't block cleanup). Every caller in `useAuth.ts` now awaits it.
* **`MemorizeView` grade keys silently skipped drill cards.** `gradeAgain` / `gradeGood` checked
  `if (submitting.value) return` but never set `submitting.value = true`. A user pressing "1" or "3"
  twice in quick succession (key auto-repeat included) executed `drillQueue.value.shift()` twice
  before the first `loadDrillCard` finished — the second card was popped off the queue without ever
  being displayed or graded. Both handlers now set `submitting` in a `try/finally`.

### Fix dead OfflineBanner click

* `OfflineBanner.vue`'s click handler was pushing `{ name: 'signin', ... }`, but the `/signin` route
  in `router/index.ts` is a bare `{ path, redirect }` shim with no `name:` field. Vue Router
  silently returned a navigation failure, so a signed-out user clicking the "Sign in to sync."
  banner stayed put — the banner did nothing. Push to `{ name: 'profiles', ... }` (which is a real
  named route) so the click actually reaches the picker. Pre-existing bug surfaced by the
  nav-redesign code review.

### `/code-review` pass on the nav redesign

* **Open-redirect via `?redirect=`.** `router/index.ts`'s `beforeEach` guard and
  `ProfilePickerView.vue`'s `redirectTarget()` were returning the raw `redirect` query parameter to
  Vue Router. A signed-in user clicking `/profiles?redirect=https://evil.com` (or a sign-in link
  with the same shape) would be navigated off-origin. New `safeRedirect()` helper rejects anything
  not starting with a single `/`; both call sites route through it.
* **Avatar popover swallows grade keys.** `ReviewView` and `MemorizeView` register their `keydown`
  listeners with `{capture: true}` and treat 1–4 / Enter / Space as grade input. The avatar
  popover's keydown listener was bubble-phase, so pressing "1" to dismiss the menu would also grade
  the current card. AppAvatar's listener moves to the capture phase and `stopImmediatePropagation`s
  the grade keys while the popover is open.
* **`onSignOut` strands the user on throw.** If `useAuth().signOut()` rejected, the explicit
  `router.push('/profiles')` never ran and the user was stuck on a half-signed-out workspace. The
  push moves into a `finally` so the user always reaches the picker.
* **Cold-boot grid collapse.** AppAvatar's outer `.avatar-wrap` was `v-if="activeProfile"`, so
  during the pre-boot window the 3-column header grid lost its right anchor and the brand + nav
  drifted right. The wrap renders unconditionally now; only the button + popover are gated.
* **Phantom mobile padding on signed-out routes.** `.site` reserved `--mobile-tab-bar-h` of bottom
  padding at ≤720 px unconditionally, even though `<MobileTabBar v-if="user">` only mounts when
  signed in. The signed-out picker / sign-in page got a dead gap at the bottom on mobile. Gated via
  a `has-user` class on `.site`.
* **Missing `env(...)` fallback inside `calc(...)`.** Browsers without `safe-area-inset-bottom`
  support drop the entire `calc()` value, collapsing the bottom padding to zero. Both call sites use
  `env(safe-area-inset-bottom, 0px)` now.
* **`profileInitials` blank fallback.** A profile with both `displayName` and `email` empty returned
  `''`, rendering a visually-blank avatar circle. Falls back to `'?'`.
* **Stale "rendered unconditionally" comment in `MobileTabBar.vue`** updated — the component is in
  fact gated by `v-if="user"` in `App.vue`.

### Keyboard + focus polish for the nav redesign

* Escape closes the identity popover (window-level `keydown` listener, paired with the existing
  click-outside dismissal).
* `:focus-visible` rings on the avatar button, popover menu items, brand link, top-bar nav links,
  and bottom tab bar tabs. Uses the existing 2 px `--color-accent` outline convention from
  `ScopeLevelSelector` and `CardPrompt`. Active-route `aria-current="page"` comes for free from Vue
  Router 4's `RouterLink`.

### Bottom tab bar at mobile widths

* New `MobileTabBar.vue` renders a fixed-bottom 5-tab bar (**Home · Review · Memorize · Settings ·
  Stats**) at viewports ≤720 px, with inline Lucide-style SVG icons and the Memorize-new pill in its
  existing spot. The inline top-bar nav hides at the same breakpoint.
* Bar respects `env(safe-area-inset-bottom)` so it sits above the iOS home indicator and Android
  gesture bar.
* `.site` reserves `calc(3.75rem + env(safe-area-inset-bottom))` of padding at the mobile breakpoint
  so the footer and any scroll content sit above the fixed bar rather than under it.

### Identity popover replaces email + switch-profile in the nav

* New `AppAvatar.vue` renders a circular avatar button (display-name initials, or the profile image
  when present) at the end of the nav. Clicking opens a popover with the display name + email,
  **Switch profile**, and **Sign out**.
* Sign-out is now reachable from the top nav for the first time: calls `useAuth().signOut()` against
  the active profile, revokes its server session, and routes to `/profiles`.
* Removes the always-visible email text and the **Switch profile** button-styled link from the nav
  row, freeing horizontal space for the upcoming responsive layout work.
* Header now uses a `1fr auto 1fr` grid: brand pinned left, nav links centered, avatar pinned right.
  Replaces the previous single-flex-row composition.

### `/dashboard` renamed to `/home`

* The route, nav label, view file (`DashboardView.vue` → `HomeView.vue`), and post-sign-in default
  redirect all rename to **Home**. The page is a landing-glance, not a widgets dashboard, and the
  new name reads truer in the nav row.
* `/dashboard` redirects to `/home`, mirroring the `/material` → `/settings` shim.

### `/material` renamed to `/settings`

* The route, nav label, view file (`MaterialView.vue` → `SettingsView.vue`), and page heading all
  rename to **Settings**. The page still contains only per-year settings today; the new name leaves
  obvious room to grow (Account, Appearance, Shortcuts) without restructuring nav.
* `/material` redirects to `/settings` so existing bookmarks and deep links keep working.
* In-app links from Dashboard's empty-CTA, MemorizeView's empty-state, and StatsView's empty-state
  all point to `/settings`.

### Distinguish `rate-limited` from `offline` in the sync indicator

* `SyncState` gains a `rate-limited` variant. The router's background `getSession()` handler now
  inspects the resolved result: a 429 error flips to `rate-limited` instead of the catch-all
  `offline`. Catches still mean a real network failure.
* `OfflineBanner.vue` renders distinct copy for the new state ("Rate limited — give it a moment,
  then try again.") and disables itself so clicking doesn't bounce the user to the sign-in picker —
  that's the right affordance for offline/signed-out, but not for being throttled. The banner flips
  back to `online` automatically on the next navigation if the bucket has refilled.
* Pairs with the api-side fixes that made 429 responses readable (CORS) and stopped drowning cheap
  session-state reads in the credential-stuffing bucket — those landed in the same branch.

## [0.1.20] — 2026-05-30

### Bundled algorithm contract

* `verse-vault-core@0.5.0` — unchanged.
* `verse-vault-wasm@0.5.0` — unchanged.

### Account data management on the profile card

* The profile card kebab menu gains **Export my data**, **Import data**, and **Delete all progress**
  (all gated on a signed-in card). Each switches the active session to that profile first
  (`enterProfile`).
* **Export** downloads the account as `verse-vault-export-<email>-<date>.json`.
* **Import** picks a JSON file, confirms (neutral — import is additive and idempotent), and shows
  the server's summary (events inserted/skipped, graduations, unresolved cards).
* **Delete all progress** is gated behind a type-the-email confirmation and offers a one-click
  backup download inside the dialog. It wipes review history and graduations across all decks but
  keeps the decks + settings.
* New: `lib/account-file.ts` (download/read helpers), `ImportResultDialog.vue`,
  `TypeToConfirmDialog.vue`; `api.ts` gains `exportAccount` / `importAccount` / `deleteAllProgress`.

## [0.1.19] — 2026-05-29

### Bundled algorithm contract

* `verse-vault-core@0.5.0` — unchanged.
* `verse-vault-wasm@0.5.0` — unchanged.

### Internal refactor

`persistLocalGraduation` and `persistLocalCardGraduation` in `lib/engine/engineStore.ts` were
near-identical 5-line helpers differing only in the snapshot field they wrote to. Folded into one
parameterised helper. No behaviour change.

## [0.1.18] — 2026-05-28

### Bundled algorithm contract

* `verse-vault-core@0.5.0` — `graduate_verse` narrows to the unconditional verse-bound kinds; new
  `graduate_card` flips a single card. HP, CCL, and conditional verse-bound kinds graduate per-card
  now.
* `verse-vault-wasm@0.5.0` — `memorize_session` returns `{ verses, orphans }`; HP/CCL ids surface
  via `hpCardId` / `cclCardId` on each verse-entry; orphan conditional cards live in the top-level
  `orphans` list (per-kind cap = the year's `lessonBatchSize`). New `WasmEngine.graduate_card`
  export.

### Standalone HP / CCL / orphan in /memorize

`MemorizeView` walks each session item as its own reading / drill / graduation step. Verses remain
verse-oriented; `HeadingPassage` (after the heading's first verse), `ChapterClubList` (after the
chapter's last verse), and conditional verse-bound cards on already-Active verses (distributed
round-robin) each get their own step-1 "Already memorized / Next" choice, drill slot in step 2 (flat
shuffle now, not per-verse interleave), and step-3 "Graduate / Not yet" prompt. Verse graduation
emits `graduate_verse` plus a `graduate_card` per conditional card it drilled; standalone
graduations go straight to `graduate_card`.

### Per-card graduation persistence

`engineStore.submitCardGraduation` queues a `graduateCard` sync event and writes the card id into
the local snapshot's new `graduatedCardIds` field. Engine boot replays both `graduatedVerseIds`
(`graduate_verse`) and `graduatedCardIds` (`graduate_card`) so the cached in-memory engine matches
what the server's `EngineStore.load` would produce.

### Target retention slider in /material settings

The "Session" panel in the year settings (`/material`) gains a **Target retention** range slider
(70–97%, default 90%). Higher values train more reviews + tighter recall; lower values mean fewer
reviews + more lapses. The knob writes to `YearSettings.desiredRetention` (new) and triggers a
cached-engine + render-cache invalidate on save so subsequent sessions schedule under the new
target. Carries `engine`-affecting status alongside the scope toggles.

## [0.1.17] — 2026-05-28

### Dashboard activity heatmap

* **GitHub-contributions-style calendar grid** of past activity, inspired by the Anki "Review
  Heatmap" addon and the WaniKani Heatmap userscript (Kumirei's #377336). Lives between the
  stability tiles and the "by year →" link.
* **Two series, toggleable.** A pill switches between **reviews** (grade events from
  `review_events`, green palette) and **memorize** (verse graduations from `graduated_verses`,
  accent-blue palette) — the verse-vault analogue of WK's reviews/lessons split.
* **September-anchored academic-year picker.** `‹ 2025–26 ›` walks back through prior academic years
  (Sep 1 → Aug 31). Disabled at the edges (no earlier data / current year).
* **Stats caption**: `current streak · best streak · total days · today · peak · total` — `today`
  hides on past academic-year views since "today" can't exist in the window. Unit (reviews / verses
  memorised) flips with the toggle.
* **Single-letter day labels** (`S M T W T F S`) on the left so every row is named.
* **Month labels centred on their dominant column run.** Each month is labelled once at the midpoint
  of the columns where it owns 4+ of 7 days, dodging the Aug/Sep collision at the academic-year
  edge.
* **Forecast** of upcoming reviews (both reference implementations include this) is deferred —
  tracked in #69.

### Bundled algorithm contract

* `verse-vault-core@0.4.0` — unchanged.
* `verse-vault-wasm@0.4.0` — unchanged.

## [0.1.16] — 2026-05-28

### Dashboard

* **New `/dashboard` view, now the app index.** Aggregates `getYears` + per-year `getStats`
  client-side. `/`, the post-sign-in default, and the brand link all land here. `/stats` keeps the
  per-year drill-down (reached via the dashboard's "by year →" link).
* **Two clickable hero tiles — Memorize and Review.** Each tile is a `RouterLink` wrapping the whole
  card with the queue count as the centrepiece: cards-to-memorize on the left, cards-due-now on the
  right (sourced from `getStats().reviewsDueCount` — server-computed via the engine, since FSRS
  retrievability doesn't live in the test_states SQL). The sub-line pairs each card count with its
  verse footprint — "fresh cards from X verses" / "cards due now from X verses" — so both units the
  user thinks in are visible at a glance.
* **Five SRS-stage tiles** (weak / learning / familiar / strong / mastered) showing cards
  (prominent) + verses (secondary) per bucket. Multi-verse cards (`HeadingPassage`,
  `ChapterClubList`) count in the cards column but their pseudo verses don't contribute to the
  verses column, so "X cards from Y verses" reads honestly. Idle (zero-count) tiles dim + extend
  vertically with centred content so the five-stage skyline holds shape.
* **"by year →" link** to `/stats` plus a small italic colophon with aggregate retention / reviews
  logged / verses held. The per-year card grid lives at `/stats` rather than the dashboard.
* **Aesthetic.** Fraunces variable serif handles display work (headings, oversized numerals, section
  rules) — loaded once via `index.html`. Body copy inherits the system stack.
* **Nav.** Adds a `Dashboard` link as the first nav entry.

### Memorize queue honours per-tier `new_scope`

Verses in a tier the user has set to `Maintenance` (e.g. "150 Active, 300 Maintenance") no longer
surface as new cards in `/memorize` or in the dashboard's "to memorize" hero. Already-graduated
cards in those tiers stay reviewable as before — only the never-graduated siblings stop being
introduced. Powered by `verse-vault-core@0.4.0`'s runtime tier filter.

### Bundled algorithm contract

* `verse-vault-core@0.4.0` — adds the dashboard stats helpers (`due_review_count`,
  `card_stability_histogram`, `verse_stability_histogram`, `new_verse_count`, `due_verse_count`,
  `learned_verse_count`, `StabilityHistogram`) and routes per-tier scopes through `ReviewEngine` at
  request time.
* `verse-vault-wasm@0.4.0` — exposes the matching `WasmEngine` wrappers; `new_card_count` now
  filters Maintenance-tier verses via the core helper.

## [0.1.15] — 2026-05-27

### ChapterClubList card rendering

* **Render the card properly.** `ChapterClubList` (the engine's pseudo-card asking "which verses in
  this chapter are in tier X?") was producing a blank `CardPrompt` shell with the deck label
  defaulting to "Card" — no template branch handled the kind. Surfaced as a user-visible bug after
  `chapter_list_scope` defaulted to `up150`. Adds a template branch, `promptLabel` case, and a
  per-verse-colour answer list driven by the new `VerseRender.chapterMembers` wire field.
* Internals: `clubTierLabel('Club150') = 'Club 150'`; the back reads the verse numbers off
  `card.verse.chapterMembers` (sourced from `verse-vault-wasm@0.2.1` / `verse-vault-core@0.2.1`).

### Bundled algorithm contract

* `verse-vault-core@0.2.1` — adds `VerseRender.chapter_members` carrying the verse numbers a
  `ChapterClubList` pseudo asks about.
* `verse-vault-wasm@0.2.1` — forwards the new field on `VerseRenderWire`.

## [0.1.14] — 2026-05-27

### Stale-row sign-in recovery

* **Silent same-email recovery.** When `signInComplete` sees the new sign-in has a different
  `user.id` but the same email as the active profile, treat it as a stale-row scenario (the
  server-side account got deleted — typical after a dev-DB wipe + fresh signup) instead of surfacing
  the conflict dialog. The stale registry row + per-profile IDB are dropped, the new ID's profile is
  upserted, and the workspace continues. Different-email conflicts still raise the dialog.
* **Pin the new session as active.** Better Auth's `multiSession` stacks cookies rather than
  replacing them, so the active device-session pointer can stay on a deleted user's token after a
  fresh sign-up — `/api/years` and friends then 401 even though sign-up was 200. `signInComplete`
  now calls `multiSession.setActive(sessionToken)` after the upsert so the new session is the one
  attached to subsequent API requests.

### Memorize "Already memorized" opt-out

* **Skip drilling per verse.** During the opening read-through, each verse now gets a secondary
  "Already memorized" button next to "Next verse / Start drilling". Clicking it graduates the verse
  immediately and removes its cards from the drill queue — useful for seeding a deck with verses the
  user already knows from elsewhere. The closing read-through skips already-graduated verses so the
  user isn't asked to confirm twice; if every verse was opt-out'd in reading_start, the session
  jumps straight to done.

### Review / Memorize keyboard shortcuts

* **Enter is the primary action** on every screen: flips a graded card front-to-back; advances
  Memorize's reading walkthroughs (Next verse, Graduate). Capture-phase listener so Enter inside the
  type-to-recite textarea flips instead of inserting a newline. On the back of a graded card
  (Review, Memorize drilling), Enter is a no-op — the user picks a grade explicitly so unintended
  re-flips don't silently auto-grade.
* **1 / 2 / 3 / 4 grade** the back as Again / Hard / Good / Easy in `/review`. Memorize only has two
  grades per screen (drill: Again / Good; reading-end: Not yet / Graduate), so 1+2 both fire the
  left button and 3+4 both fire the right one — left/right matches the Review row's split so muscle
  memory carries over and no key sits inert.
* Both placeholders now say "or just recite aloud and flip" instead of "skip", to match the
  Reveal-button vocabulary now that Enter is wired up.

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

### Bundled algorithm contract

* `verse-vault-core@0.2.0` — unchanged.
* `verse-vault-wasm@0.2.0` — unchanged.

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
