# Account data management (export / import / reset) — design

**Status:** approved design, pre-implementation **Date:** 2026-05-29 **Scope:** `apps/web` (UI) +
`packages/api` (one new endpoint). One feature PR.

## Goal

Give a signed-in user three account-data actions from the profile card's kebab menu:

1. **Export my data** — download the account's full data as a JSON file.
2. **Import data** — upload a previously-exported (or Anki-converted) JSON file, layering it onto
   the account.
3. **Delete all progress** — wipe the account's learning state (review history, graduations, derived
   FSRS state) across every deck, behind a GitHub-style type-the-email confirmation, with a
   one-click backup download inside the confirm dialog.

Export and import wire into the already-shipped `GET /api/export` / `POST /api/import` endpoints
(api 0.1.25). Delete-all-progress needs a **new** server endpoint.

## Background / current state

* **No settings page.** Account-level actions live on `ProfileCard.vue`'s kebab (`⋮`) menu — today
  just **Sign out** (gated on `signedIn`) and **Delete profile**. The cards live in
  `ProfilePickerView.vue` (route `/profiles`), which owns the delete-confirm flow via the reusable
  `ConfirmDialog.vue`.
* **Multi-profile / multi-session.** `useAuth.ts` tracks `activeProfile` (stable `profileId` =
  server `userId`) and a `profiles` list. The api client (`api.ts`) carries no profile id — it
  relies purely on the Better Auth session cookie (`credentials: 'include'`). "The account the API
  talks to" ≡ the last `multiSession.setActive` target ≡ `activeProfile`.
* **Switching is silent + password-less** when a profile's stored `sessionToken` is live:
  `enterProfile(profileId)` calls `multiSession.setActive`, swaps the per-profile IDB database, and
  returns `{ ok: false }` only when the token is dead (→ reauth via the sign-in form). `ProfileCard`
  already binds `:signed-in="p.sessionToken !== null"` and
  `:active="activeProfile?.profileId === p.profileId"`.
* **No file-I/O precedent** in the web app (no Blob download, no `<input type=file>`). This feature
  establishes that pattern.
* **No web test harness** (repo convention). Server has `routes/account.test.ts` round-tripping
  export→import.
* **API client** (`apps/web/src/api.ts`) is a typed `ApiClient` interface + `createApiClient`
  factory with a private `request(method, path, body?)` that `res.json()`-parses every response.
  `GET /api/export` returns JSON via `c.json(...)`, so it fits `request('GET', ...)` directly — the
  client builds the download Blob from the returned object. The request method union is
  `'GET' | 'POST' | 'PATCH'` and must gain `'DELETE'`.
* **Import is additive + idempotent**, not a wipe: review events dedup on the unique
  `(userId, materialId, clientEventId)` index, graduations insert `onConflictDoNothing`, settings
  merge by `max(updatedAt)` with a `>=` guard. Re-importing the same file is a safe no-op. This
  justifies _neutral_ (not destructive) framing for the import confirm.

## Decisions (locked via brainstorming)

| Decision       | Choice                                                                 |
| -------------- | ---------------------------------------------------------------------- |
| Placement      | ProfileCard kebab menu (with Sign out / Delete profile)                |
| Card scope     | Every card — switch to that profile first via `enterProfile`           |
| Import gating  | Confirm dialog → result summary modal                                  |
| Import framing | **Neutral** (additive + idempotent, not destructive)                   |
| Delete scope   | **Learning state only** — keep enrollments + year settings             |
| Delete confirm | Type the **account email** exactly to enable the button                |
| Delete dialog  | Includes a **"Download a backup (.json)"** button (same export action) |
| PR split       | **One** feature PR                                                     |

## Server: `DELETE /api/account/progress`

### Route (`packages/api/src/routes/account.ts`)

Add to the existing `accountRoutes`:

```
app.delete('/account/progress', async (c) => {
  const user = getUser(c)
  const summary = await deleteAccountProgress(deps.db, deps.engines, user.id)
  return c.json(summary)   // ProgressDeletionSummary
})
```

(`requireAuth()` already applies via `app.use('*', requireAuth())`. Mounted under `/api`, so the
full path is `/api/account/progress`.)

### Logic (`packages/api/src/lib/reset.ts`, new)

```
deleteAccountProgress(db, engines, userId): ProgressDeletionSummary
```

For every material the user is enrolled in (`user_materials` rows for `userId`), hold
`engines.withLock(key, async () => { ... })` and inside one transaction delete the user's rows from,
in this order:

* `review_events`
* `graduated_verses`
* `graduated_cards`
* `test_states`

Then `engines.invalidate(key)` so the cached engine is dropped; the next load rebuilds from empty
events → empty `test_states`, no graduations → all cards `New`. **No explicit `rebuildFromEvents`
needed** — invalidate-then-lazy-rebuild is sufficient and cheaper.

**Kept untouched:** `user_materials` (enrollment), `user_year_settings` (scopes/retention),
`graph_snapshots` (content version). So the decks remain in the user's list with their tuned
settings, just reset to all-new.

`withLock` per material mirrors the import path and the documented `rebuildFromEvents`/cache
contract — the delete must not race a concurrent review POST for the same `(user, material)`.

Return:

```ts
interface ProgressDeletionSummary {
  materialsReset: number      // count of enrolled materials touched
  eventsDeleted: number       // total review_events rows removed
  graduationsDeleted: number  // graduated_verses + graduated_cards rows removed
}
```

Idempotent: a second call deletes nothing more and returns zeros.

### Server tests

* `packages/api/src/lib/reset.test.ts`: seed a user with events + graduations + test_states +
  settings across ≥1 material → `deleteAccountProgress` → assert `review_events` / `graduated_*` /
  `test_states` empty for the user, while `user_materials` and `user_year_settings` rows survive;
  assert the returned counts; assert a second call returns zeros (idempotent).
* `packages/api/src/routes/account.test.ts`: `DELETE /api/account/progress` returns 401
  unauthenticated; authenticated round-trip wipes a seeded account and returns the summary; after
  delete, `GET /api/export` shows empty `materials[].reviewEvents` / `graduatedVerses` but the
  material still present.

## Web: profile-card actions

### `apps/web/src/api.ts`

* Extend the `request` method union to `'GET' | 'POST' | 'PATCH' | 'DELETE'`.
* Add types: an opaque `AccountExport` (`Record<string, unknown>` — the web only downloads +
  re-uploads it), `ImportSummary`, `ProgressDeletionSummary`.
* Add to the `ApiClient` interface + factory:
  * `exportAccount(): Promise<AccountExport>` → `request('GET', '/api/export')`
  * `importAccount(payload: unknown): Promise<ImportSummary>` →
    `request('POST', '/api/import', payload)`
  * `deleteAllProgress(): Promise<ProgressDeletionSummary>` →
    `request('DELETE', '/api/account/progress')`

```ts
interface ImportSummary {
  materialsApplied: number
  eventsInserted: number
  eventsSkipped: number
  graduationsApplied: number
  unresolvedCardRefs: number
}
```

### `apps/web/src/lib/account-file.ts` (new)

Pure file-I/O helpers, kept framework-free so they're trivially testable if a harness lands later:

* `downloadJson(filename: string, data: unknown): void` — `JSON.stringify` → `Blob` →
  `URL.createObjectURL` → temporary `<a download>` click → revoke.
* `readJsonFile(file: File): Promise<unknown>` — `await file.text()` → `JSON.parse` (throws on
  malformed JSON; caller surfaces the error).
* `exportFilename(email: string, isoDate: string): string` →
  `verse-vault-export-<email>-<YYYY-MM-DD>.json` (sanitise the email for a safe filename).

### `apps/web/src/components/ProfileCard.vue`

* Add emits `(e: 'export')`, `(e: 'import')`, `(e: 'delete-progress')`.
* Add three `menu-item` buttons gated on `signedIn` (same pattern as the existing `onSignOutClick`:
  `ev.stopPropagation()`, `closeMenu()`, `emit(...)`): **Export my data**, **Import data**, then a
  separated destructive **Delete all progress** (uses the `--color-grade-again` red, like a future
  destructive item). Order: Export, Import, Sign out, Delete all progress, Delete profile.

### `apps/web/src/components/ImportResultDialog.vue` (new)

Neutral modal (same overlay/aria conventions as `ConfirmDialog`) showing an `ImportSummary` as a
readable list (materials applied, events inserted, events skipped, graduations applied, unresolved
card refs) with a single **Done** button. Also renders an error state (string message) for failed
imports so one component covers both outcomes.

### `apps/web/src/components/TypeToConfirmDialog.vue` (new, reusable)

Destructive modal generalising `ConfirmDialog`:

* Props: `title`, `confirmLabel`, `matchText` (the string the user must type), `busy`, plus a
  default slot for the warning body (so the picker can slot in the **Download a backup** button +
  copy).
* A text `<input>`; the confirm button is `disabled` until `input.trim() === matchText`. Destructive
  styling.
* Emits `confirm` / `cancel`; overlay-click + Esc cancel.

The **Download a backup** button lives in the slotted body (provided by the picker), wired to the
same `exportActiveAccount()` handler — it's a safety net, non-blocking, and doesn't gate the
confirm.

### `apps/web/src/views/ProfilePickerView.vue` (orchestration)

Owns the new state + handlers, mirroring how it already owns `pendingDelete` + `ConfirmDialog`:

* A hidden `<input type="file" accept="application/json">` ref for import.
* State: `pendingImport` (the chosen profile + parsed payload), `importResult` (`ImportSummary` |
  error), `pendingDeleteProgress` (chosen profile), per-action `busy` and `error` refs.
* A shared `switchTo(profile)` helper: if `profile.profileId !== activeProfile`,
  `await enterProfile(profile.profileId)`; on `{ ok: false }`, fall through to the existing reauth
  path (`prefillEmail` + `mode = 'add'`) and abort. (Menu items are gated on `signedIn`, so this is
  the rare token-died-mid-session case.)
* A shared `exportActiveAccount()` helper:
  `const data = await api.exportAccount(); downloadJson(exportFilename(activeProfile.email, today), data)`.
  Used by both the kebab **Export** item (after `switchTo`) and the **Download a backup** button
  inside the delete dialog.
* `onCardExport(p)` → `await switchTo(p)` → `exportActiveAccount()`.
* `onCardImport(p)` → `await switchTo(p)` → open the file picker → on file: `readJsonFile` → set
  `pendingImport` → neutral `ConfirmDialog` (import is additive). On confirm:
  `api.importAccount(payload)` → set `importResult` → show `ImportResultDialog`. JSON-parse failure
  or `ApiError` (400/413) → `ImportResultDialog` error state.
* `onCardDeleteProgress(p)` → `await switchTo(p)` → set `pendingDeleteProgress` →
  `TypeToConfirmDialog` (`matchText = p.email`, backup button slotted) → on confirm:
  `api.deleteAllProgress()` → success banner with the deletion counts; `ApiError` → error banner.

### Confirm copy

* **Import** (`ConfirmDialog`, neutral): "Import data into **&lt;email&gt;**? This adds review
  history and graduations from the file. Existing data is kept, and re-importing the same file is
  safe."
* **Delete all progress** (`TypeToConfirmDialog`, destructive): "This permanently deletes **all
  review history, graduations, and progress** for **&lt;email&gt;** across every deck. Your decks
  and settings stay. This cannot be undone." + a **Download a backup (.json)** button + "Type
  **&lt;email&gt;** to confirm:" input.

## Error handling

* **Export**: `ApiError` (e.g. 401 stale session, network) → inline error banner on the picker.
* **Import**: malformed JSON (`readJsonFile`/`JSON.parse` throws, before any network call) → error
  in `ImportResultDialog`; `400` (unsupported/unknown `exportVersion`, unknown `materialId`, invalid
  settings bounds) and `413` (>50 MB) → surface `ApiError.message` in the dialog's error state;
  offline → error.
* **Delete**: `ApiError` → error banner; the type-to-confirm guard prevents accidental triggers.
* **Switch**: `enterProfile` `{ ok: false }` → reauth fallback, action aborted.

## Release

* `packages/api`: 0.1.25 → **0.1.26** (new `DELETE /api/account/progress`); promote `[Unreleased]` →
  dated `[0.1.26]` in `packages/api/CHANGELOG.md`, carrying `verse-vault-core@0.5.0` /
  `verse-vault-wasm@0.5.0` forward.
* `apps/web`: 0.1.19 → **0.1.20**; matching `apps/web/CHANGELOG.md` entry, same contract versions
  carried forward.
* `docs/server-api.md`: document `DELETE /api/account/progress` (and confirm `GET /api/export` /
  `POST /api/import` are documented from the prior PR; add if missing).
* No `crates/{core,wasm}` change — no contract-crate bump.

## Out of scope

* Per-material / per-year progress reset (this wipes **all** materials at once).
* Full account deletion (already exists as "Delete profile").
* A general settings page (the kebab is the chosen surface).
* A web unit-test harness (none exists; helpers kept pure for later).
* The double-engine-construction perf follow-up (issue #89) — unrelated.

## Build order (for the implementation plan)

1. Server: `lib/reset.ts` + `reset.test.ts` (TDD), then the route + route tests.
2. Web api client: types + three methods + `'DELETE'`.
3. Web: `account-file.ts` helpers.
4. Web: `ImportResultDialog.vue`, `TypeToConfirmDialog.vue`.
5. Web: `ProfileCard.vue` menu items + emits.
6. Web: `ProfilePickerView.vue` orchestration (switch-first, export, import, delete-progress,
   backup-in-dialog).
7. Docs + version bumps + CHANGELOG entries.
8. Manual verification: export downloads a valid file; re-import shows a correct (idempotent)
   summary; delete-all-progress wipes learning state, keeps decks + settings, and the in-dialog
   backup downloads.
