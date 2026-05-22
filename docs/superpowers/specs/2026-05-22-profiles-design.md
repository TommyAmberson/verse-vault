# Profiles + offline-first boot — design

## Status

Brainstormed 2026-05-22. Implementation pending.

## Summary

Today the web app's router blocks render on `authClient.getSession()`. If the API is unreachable,
the screen stays blank — even when there's already a valid session cookie and locally cached
content. This breaks the "fat-client works offline" promise from PR #46 in the most visible way
possible (the entry path).

This phase introduces **profiles**: a local-first identity layer that decouples "who is this
device's data for?" from "is there a live server session right now?" Each profile owns its own
IndexedDB database; the auth status of that profile is a runtime attribute that flips between online
and offline. The router auto-enters the last-used profile on launch and the workspace renders from
the cached DB immediately, regardless of network state.

The same infrastructure also enables multi-profile usage on shared devices (rare per the current
user base but cheap to support given the per-profile DB shape).

## Concept

A **profile** is a local persistent identity:

* Created when a user signs in to a server account for the first time on a given device.
* Tied to a specific server account by `userId`.
* Owns an IndexedDB database named `verse-vault-${userId}` containing all of that user's cached
  content (snapshots, testStates, eventQueue, eventQueueOrphans, renders).
* Persists across sign-outs. Sign-out clears only the active session cookie, not the profile.
* Can be entered while offline (no session): cached cards display, grades queue, sync waits.

A **shared registry** database `verse-vault-registry` holds:

* One entry per profile: `{ profileId, email, displayName, image?, lastUsedAt, createdAt }`.
* A `lastActiveProfileId` pointer.

The registry is the only thing read before knowing which per-profile DB to open. Everything inside a
profile's DB stays scoped to that profile.

## Data model

### Registry DB

Database name: `verse-vault-registry`. Single version, single store.

Object store `profiles`:

* Key path: `profileId` (string — the server's `userId`).
* Row shape:
  ```ts
  interface ProfileRow {
    profileId: string        // server userId
    email: string
    displayName: string      // from session.user.name; falls back to email
    image: string | null     // from session.user.image
    createdAt: number        // unix secs
    lastUsedAt: number       // updated on every profile entry
  }
  ```

Object store `meta`:

* Key path: implicit (single row, keyed by `'singleton'`).
* Row shape: `{ key: 'singleton', lastActiveProfileId: string | null }`.

No indexes; lookups are direct by key or full scan (registry is small — bounded by # of profiles on
this device, realistically < 10).

### Per-profile DB

Database name: `verse-vault-${profileId}`. Same 5 stores as today's `verse-vault` DB: `snapshots`,
`testStates`, `eventQueue`, `eventQueueOrphans`, `renders`. No key-shape changes inside — the
existing helpers move verbatim, parameterised by which DB they open.

The `DB_VERSION` constant from `persistence.ts` stays at 1 for new per-profile DBs (since they start
fresh, no migration needed). The upgrade-handler logic still applies for forward evolutions.

## Lifecycle

```
               ┌──────────────────────────────────┐
               │           App launch             │
               └──────────────────────────────────┘
                               │
                               ▼
               ┌──────────────────────────────────┐
               │  Read verse-vault-registry       │
               │  → lastActiveProfileId           │
               └──────────────────────────────────┘
                               │
           ┌───────────────────┴───────────────────┐
     null/missing                              has value
           │                                      │
           ▼                                      ▼
┌──────────────────┐                  ┌──────────────────────┐
│  Profile picker  │                  │  Open profile DB     │
│  (0-profile      │                  │  Mount workspace     │
│   empty state    │                  │  (immediate render)  │
│   if registry    │                  └──────────────────────┘
│   also empty)    │                              │
└──────────────────┘                              ▼
           │                          ┌──────────────────────┐
           ▼                          │  Background sync     │
┌──────────────────┐                  │  attempt             │
│  Sign-in form    │                  └──────────────────────┘
│  (Add profile or │                              │
│   first profile) │           ┌──────────────────┴───────────┐
└──────────────────┘         success                       failure
           │                    │                             │
           ▼                    ▼                             ▼
┌──────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│  Create profile  │  │  Profile = online    │  │  Profile = offline   │
│  + enter         │  │  (no banner)         │  │  Banner: sign in /   │
└──────────────────┘  └──────────────────────┘  │  syncing N events    │
                                                └──────────────────────┘
```

### Launch

1. Open `verse-vault-registry`, read `meta.singleton.lastActiveProfileId`.
2. If null OR the referenced profile DB doesn't exist → route to the picker.
3. Otherwise open `verse-vault-${lastActiveProfileId}` and mount the workspace immediately.
4. In background, call `authClient.getSession()` and attempt the first sync flush. The result sets a
   single online/offline flag on the active profile (managed by `useAuth` or a new `useProfile`
   composable).
5. The workspace UI renders an offline banner when the flag is offline; no banner when online.

### Sign-in (create or attach)

The existing sign-in form is reused for both "create the first profile" and "add another profile"
paths. After Better Auth completes the sign-in:

1. Read the resulting session's `user` object.
2. Check the registry for a profile with `profileId === user.id`.
3. If exists → update `lastUsedAt`, set `lastActiveProfileId` to this id, open its DB, enter the
   workspace.
4. If new → create a registry entry from the session user, set `lastActiveProfileId`, open the
   newly-created per-profile DB (empty), enter the workspace. The engine's `loadEngine` will fetch
   the snapshot from the server on first material visit, populating the DB.

### Sign-out

Sign-out (from the picker — see below; no sign-out affordance in the workspace itself):

1. Best-effort call to `authClient.signOut()` (server-side session invalidation). Failure here is
   tolerated; the profile may be offline.
2. Clear the session cookie locally regardless.
3. Profile entry + per-profile DB stay untouched. The profile card on the picker remains.
4. If the signed-out profile was the active one, clear `lastActiveProfileId` (so the next launch
   shows the picker rather than auto-entering a now-signed-out profile).

### Switch profile

From the workspace, the user menu offers "Switch profile" → routes to the picker.

From the picker, tapping a profile card:

1. Free the current profile's WASM engine instances (via `engineStore.clearAllSessions()` or
   equivalent).
2. Close the current profile's IDB handle.
3. Open the new profile's IDB.
4. Update `meta.singleton.lastActiveProfileId` and the chosen profile's `lastUsedAt`.
5. Route into the workspace.

The background sync attempt runs after entry, flipping online/offline appropriately.

### Delete profile

From the picker's per-card kebab menu, "Delete profile" → confirmation dialog ("Remove profile and
all local data? This won't affect your verse-vault account on the server.") → on confirm:

1. Remove the registry entry.
2. Delete the per-profile IDB database (`indexedDB.deleteDatabase('verse-vault-${id}')`).
3. If the deleted profile was active, clear `lastActiveProfileId`.
4. Card disappears from the picker.

## UI surfaces

### Profile picker

Path: `/profiles` (rename from `/signin`; old `/signin` redirects there for back-compat within the
SPA — Better Auth links + bookmarks).

States:

* **Empty registry:** Renders the existing email/password + Google sign-in form directly, framed as
  "Sign in to create your first profile." After sign-in, the new profile is created and the user
  routes to /review.
* **1+ profiles:** Renders a vertical list of profile cards plus an "Add another profile" button at
  the bottom. Each card:
  * Left: 40×40 avatar (image if available; otherwise initials in a coloured circle).
  * Middle: display name (bold) above email (muted) above "Last used N hours/days ago".
  * Right: a kebab (⋮) button. Tapping it opens a dropdown with two items:
    * **Sign out** — best-effort API call + clear local state. Card stays. Card now reflects "signed
      out" subtly (e.g., dimmed kebab, or a small muted "signed out" tag).
    * **Delete profile** — opens the confirmation dialog (above).
  * Tapping the card body anywhere outside the kebab enters the profile.

Tapping "Add another profile" pushes the existing sign-in form as a sub-view. After sign-in, the new
profile is created and the user is routed into the workspace.

### Workspace adjustments

Two small additions:

1. **Offline banner.** When the active profile's session state is offline (cookie missing OR server
   unreachable OR last sync failed), a thin banner sits between the header and the route view:
   "Offline — sign in to sync N grades." The number is the count of unsynced events in the
   per-profile `eventQueue`. Clicking it routes to the sign-in form pre-filled with the profile's
   email (and skips back to the workspace on success).
2. **User menu → "Switch profile".** Replaces the existing "Sign out" entry. Sign-out lives on the
   picker; the workspace just lets you go to the picker.

## Sync + offline behaviour

The existing sync logic in `engineStore.ts` is unchanged. The new pieces:

* Background sync attempts on the same cadence (debounced after grades, on visibilitychange, on
  beforeunload).
* Sync result feeds a single `profile.online` flag (reactive ref). The banner derives from this
  flag + the pending-event count.
* Online → offline transition is triggered by any sync failure (network OR 401 OR anything).
* Offline → online transition happens automatically when a sync attempt succeeds.

The user doesn't see "session expired" as a distinct state — only "offline." Re-auth from the banner
flips the flag back to online when sync next succeeds.

## Conflict cases

### Re-auth returns a different user

Scenario: the user is in profile A, the session is offline, they click the offline banner to sign
in, the form returns user B's session.

Behaviour: detect the mismatch (`session.user.id !== activeProfile.id`), surface a prompt:

> "This profile is for alice@example.com but you just signed in as bob@example.com. [Cancel] [Add
> bob@example.com as a new profile]"

Cancel → sign out the just-signed-in B session, return to the workspace in profile A's offline
state.

"Add as new" → create a new profile entry for B, route into the new profile.

### Registry points to a missing DB

Scenario: `lastActiveProfileId = 'abc'` but `indexedDB.databases()` doesn't list `verse-vault-abc`
(manual user action, dev-tools wipe, browser cleared site data).

Behaviour: on launch, after reading `lastActiveProfileId`, check if the per-profile DB exists. If
not, fall back to the picker. The registry entry stays (the user can attempt re-entry).

### Conflicting writes on same profile across tabs

Not addressed here — pre-existing behaviour. Each tab opens its own connection to the same profile
DB. IDB transactions serialise; no design change.

## Migration

On the first sign-in after this lands:

1. The new profile is created from the sign-in response.
2. Before opening the new per-profile DB, the migration helper checks for the legacy un-namespaced
   `verse-vault` DB.
3. If present: copy each of its 5 stores into the corresponding stores of the new profile DB. Use
   cursors to iterate; bulk-put into the new DB inside a single transaction per store.
4. After successful copy, delete the legacy DB via `indexedDB.deleteDatabase('verse-vault')`.
5. Continue with the normal post-sign-in flow.

The migration runs once: subsequent sign-ins find no legacy DB and skip. If the migration fails
mid-flight, the legacy DB stays intact and the new profile DB is left in whatever state the partial
copy reached (acceptable: the user can retry by signing out + back in, or the engine's `loadEngine`
will refetch from the server on first material visit).

For users who have never signed in pre-upgrade, no migration runs.

For users who have multiple unsynced events in the legacy DB and try to use a different account
post-upgrade as their first sign-in: the events get migrated to that wrong account's profile. This
is a rare edge case; documented but not specifically guarded.

## Phasing

The change splits into three PRs that are individually shippable. Order matters; PR A blocks PR B,
and PR C builds on the profile model PR A introduces but is otherwise independent.

### PR A — Profile infrastructure + offline boot

Goal: render the workspace immediately on launch from cached data. No picker UI yet — the existing
sign-in form is the only entry point for unauthenticated users, but its post-sign-in behaviour
creates a profile entry under the hood.

Changes:

* New `apps/web/src/lib/engine/registry.ts`: registry DB helpers (open, read profiles, write
  profile, update lastActiveProfileId, delete profile).
* New `apps/web/src/lib/engine/migrate-legacy.ts`: one-shot migration helper.
* `apps/web/src/lib/engine/persistence.ts`: rework `openDb()` to accept a profileId; current
  module-level singleton becomes a "current handle" that swaps on profile entry. All existing
  helpers (`getSnapshot`, `putSnapshot`, etc.) read from the current handle.
* `apps/web/src/lib/engine/engineStore.ts`: add `clearAllSessions()` callable from profile switch.
  Audit module-level state for anything else that needs reset on switch.
* `apps/web/src/composables/useAuth.ts` (or a new `useProfile.ts`): manage the active profile
  * online/offline flag; expose actions for sign-in (create-or-update profile), sign-out, switch.
* `apps/web/src/router/index.ts`: replace the blocking `getSession()` await with a registry read. If
  `lastActiveProfileId` resolves, open the DB and let the route render; otherwise redirect to
  /signin.
* `apps/web/src/lib/authClient.ts`: extend the wrapped `signOut` to update the registry (clear
  `lastActiveProfileId` if the signed-out profile is active).
* `apps/web/src/views/*.vue`: add the offline banner component, slot it into the layout.
* `apps/web/CHANGELOG.md`: [Unreleased] entry under a new "Offline" subsection.

Not in PR A: picker UI, "Switch profile" in user menu, per-profile kebab actions, manage- profiles
settings page.

The existing sign-out button (currently in the workspace user menu) stays in place for PR A — it
just gets the new "clear session, keep profile" semantics. PR B moves sign-out off the workspace
entirely and onto the picker.

Expected size: ~400 LOC.

### PR B — Picker UI

Goal: surface the multi-profile UX. Built entirely on PR A's infrastructure.

Changes:

* `apps/web/src/views/ProfilePickerView.vue` (replaces/extends `SignInView.vue`): renders the
  profile card list + kebab menu, or the empty-state sign-in form when registry is empty.
* Card component with avatar, name/email, last-used, kebab.
* Confirmation dialog component for delete-profile.
* `apps/web/src/router/index.ts`: route `/profiles` to the picker; redirect `/signin` to `/profiles`
  for back-compat.
* `apps/web/src/views/MaterialView.vue` (or wherever the user menu lives): add "Switch profile"
  entry that routes to `/profiles`.

Not in PR B: the substantive infrastructure (that's PR A) or any new offline behaviours.

Expected size: ~250 LOC.

### PR C — Device tokens for stale-cookie render refresh

Goal: a user whose Better Auth session has expired (cookie gone, but the device is otherwise healthy
and online) can still refresh stale renders from the API without being forced to re-sign-in. Writes
(grades, graduations, sync flush) still require a fresh session — the device token is read-only.

The narrow UX gap this closes: card viewed online 31 days ago, app signed-out/offline since, back
online but cookie is gone. Today `/api/cards/:cardId` returns 401, the render stays expired in IDB,
the user sees a blank space until they re-sign-in. After PR C, the device token authenticates the
read, the render refreshes, the user keeps going.

#### Server

New table:

```sql
CREATE TABLE device_tokens (
  token TEXT PRIMARY KEY,         -- random opaque, ~256-bit URL-safe
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,    -- unix secs
  last_seen_at INTEGER NOT NULL   -- unix secs; updated on every request
);
CREATE INDEX idx_device_tokens_user ON device_tokens (user_id);
```

Issuance:

* On every successful Better Auth sign-in (email/password + social), mint a new token and set it as
  a long-lived cookie. The cleanest hook is a Better Auth `after`/`hooks` handler on the sign-in
  callback; if that proves awkward, fall back to a `POST /api/auth/device-token` endpoint the client
  calls right after sign-in.
* Cookie: `Set-Cookie: vv-device=<token>; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000; Path=/`
  (1-year `Max-Age` — practical "doesn't expire" without being literally infinite).
* If the user signs in from a device that already has a `vv-device` cookie, reuse it (look up by
  token; if it matches the just-signed-in user, refresh `last_seen_at`; if it doesn't, issue a new
  one — the old one keeps working for whoever it belonged to until it ages out).

New middleware `requireDeviceOrSession`:

* Try Better Auth session first; if present, populate `c.var.user` and continue.
* If no session, look for `vv-device` cookie. If present, look up the token row, populate
  `c.var.user` with `{ id: token.user_id, ... }` (we can join `user` for email/name if needed for
  logging), and continue. Update `last_seen_at` in the same request (async; don't block).
* If neither, 401.

Applied to: `GET /api/cards/:cardId` and `GET /api/materials/:id/renders`. Both are read-only
renders, both have MAUA bulk-extraction concerns that rate-limiting + user-binding adequately
mitigate.

NOT applied to:

* `POST /api/sync/:materialId/events` (writes — state mutations).
* `GET /api/sync/:materialId/state` (returns testStates — per-user state, leak-sensitive).
* `POST /api/years/:materialId/settings` (writes).
* `POST /api/materials/enroll` (writes).
* `PATCH /api/materials/:id/offline-mode` (writes — toggles per-user flag).
* `GET /api/materials/:id/status` (returns enrolment + offline-mode state — sensitive enough to gate
  on a real session).
* Anything under `/api/auth/*` — Better Auth manages those internally.

Rate limit per device token: simple sliding-window counter in process memory. Suggested ceiling: 1k
requests/day per token. Generous for legitimate use (a heavy daily reviewer flips through ~200 cards
a day with most served from IDB cache); chokes obvious bots. The counter lives in memory because
verse-vault is single-instance; if we ever scale horizontally, move to a SQLite-backed
sliding-window or a Redis-like layer.

#### Client

No new code paths needed beyond letting the existing cookie machinery flow:

* `apiClient` already uses `credentials: 'include'` on every fetch, so the `vv-device` cookie
  travels alongside the session cookie automatically. Same applies inside the Tauri webview.
* On first sign-in post-PR-C, the server sets the cookie in the response to the sign-in call. The
  client doesn't need to know; subsequent requests carry it.

One small UX consideration: when a user is on a device-token-only auth state (no fresh session), the
offline banner from PR A still appears because the session attempt to `getSession` returns null.
That's correct — they ARE signed out as far as Better Auth is concerned. The banner just prompts
them to sign in to get a fresh session, which they need for writes anyway. Renders refresh
transparently in the background while they're in this state.

#### Revocation

Per the "doesn't need to be invalidated" framing, there's no explicit revoke API. Cleanups that
happen anyway:

* `ON DELETE CASCADE` on the user FK drops all tokens for that user when an account is deleted
  (rare).
* PR B's "Delete profile" flow can optionally call a `DELETE /api/auth/device-token` endpoint to
  clean up server-side. Even if it doesn't, the token ages out via the sliding TTL below.
* **Sliding 1-year TTL.** Server prunes tokens whose `last_seen_at` is older than 1 year on every
  API boot (mirrors the `apibible_cache.pruneExpired()` pattern). Dormant devices forget themselves
  naturally; active devices renew their `last_seen_at` on every request and never expire.

If a token ever does get genuinely compromised and we want explicit revocation, adding a
`DELETE /api/auth/device-token/:token` endpoint or a row-by-row admin view is straightforward — but
not in scope for PR C.

#### MAUA implications

* **Bulk extraction (clause #4):** rate-limit-per-token × tokens-per-legitimate-user ×
  legitimate-user-count = bounded throughput. For verse-vault's user base, well within bounds.
  Compare to the unauth case where this guard doesn't exist at all.
* **30-day cache TTL (clause #1):** unchanged. Client still expires renders at 30d; with a valid
  device token, it can refresh them without prompting a re-sign-in. The clause is about server-side
  cache freshness, not about session lifetime.
* **No AI/LLM training (clause #2/#3):** unchanged. No new API surface emits raw api.bible HTML;
  same `composeRender` output as today.

#### Migration

New table; no migration of existing data needed. Schema bump lands as the next
`migrations/0017_device_tokens.sql`. Existing sessions stay valid; users get a device token the next
time they sign in (or one can be backfilled lazily on first device-token-required request).

#### Critical files (PR C)

Created:

* `packages/api/migrations/0017_device_tokens.sql`
* `packages/api/src/lib/device-token.ts` — mint, lookup, prune helpers
* `packages/api/src/middleware/device-or-session.ts` — the relaxed auth middleware

Modified:

* `packages/api/src/db/schema.ts` — add `device_tokens` table definition
* `packages/api/src/lib/auth.ts` — wire the sign-in callback to mint a token
* `packages/api/src/routes/cards.ts` — swap `requireAuth` → `requireDeviceOrSession` on
  `GET /:cardId`
* `packages/api/src/routes/materials.ts` — same swap on `GET /:id/renders`
* `packages/api/src/index.ts` (or wherever startup hooks live) — call `pruneExpiredDeviceTokens()`
  on boot
* `packages/api/CHANGELOG.md` — entry + version bump

Expected size: ~200 LOC.

Out of scope for PR C:

* Explicit revocation UI / API.
* Per-IP rate limiting on top of per-token.
* Token rotation on a schedule (sliding TTL is enough).

## Critical files

PR A:

* `apps/web/src/lib/engine/persistence.ts` (substantial rework)
* `apps/web/src/lib/engine/engineStore.ts` (small additions)
* `apps/web/src/lib/engine/registry.ts` (new)
* `apps/web/src/lib/engine/migrate-legacy.ts` (new)
* `apps/web/src/composables/useAuth.ts` (or new `useProfile.ts`)
* `apps/web/src/lib/authClient.ts`
* `apps/web/src/router/index.ts`
* `apps/web/src/App.vue` (slot the offline banner)
* New banner component (`apps/web/src/components/OfflineBanner.vue`)
* `apps/web/CHANGELOG.md`

PR B:

* `apps/web/src/views/ProfilePickerView.vue` (new or rename from SignInView)
* New components: `ProfileCard.vue`, `DeleteProfileDialog.vue`
* `apps/web/src/router/index.ts` (route + redirect)
* Update to wherever the workspace user menu lives
* `apps/web/CHANGELOG.md`

## Verification

End-to-end manual smokes; no new automated test infrastructure required (apps/web has none today).

PR A:

1. **Cold start, fresh install:** open `pnpm tauri dev`. Picker (empty state via sign-in form)
   renders. Sign in. Confirm `verse-vault-registry` exists with one profile entry, and
   `verse-vault-${userId}` exists with the snapshot.
2. **Warm start, online:** restart. Confirm the workspace renders immediately, banner doesn't show,
   sync flush succeeds in DevTools network.
3. **Warm start, offline:** kill the API process or DevTools → Network → Offline. Restart. Confirm
   workspace renders immediately, "Offline — sign in to sync N grades" banner appears. Grade a card;
   confirm event queues in IDB.
4. **Reconnect from offline:** restore network. Confirm the banner clears within the sync debounce
   window and queued events flush.
5. **Sign out:** use the existing sign-out button in its current location (PR A doesn't move it).
   Confirm the profile + per-profile DB stay intact and `lastActiveProfileId` clears. On next
   launch, the picker (still the empty sign-in form in PR A) appears.
6. **Migration:** before merging PR A, snapshot an existing `verse-vault` DB locally. After applying
   PR A and signing in for the first time, confirm the new `verse-vault-${userId}` DB has the same
   data and `verse-vault` is gone.

PR B:

7. **Picker with one profile:** sign in, sign out, return to /profiles. Card visible with correct
   avatar/name/email/last-used.
8. **Add another profile:** click "Add another profile," sign in as a different user, confirm a
   second card appears and the new profile is active.
9. **Switch profiles:** tap the second profile's card. Confirm the workspace re-renders with the new
   profile's data (engine reloaded, cached cards from B not A).
10. **Sign out from picker kebab:** confirm the card stays but the kebab/state reflects signed-out.
11. **Delete profile:** kebab → Delete → confirm dialog → confirm. Card disappears; verify
    `verse-vault-${id}` is gone from `indexedDB.databases()`.
12. **Different-user conflict:** in profile A signed-out, click banner sign-in, sign in as user B.
    Confirm the conflict prompt appears with the two options.

`pnpm --filter @verse-vault/web run type-check` clean. `pnpm --filter @verse-vault/api test`
unchanged at 101/101 (no server changes).

## Open items / non-blocking decisions

These are spelled out here so the implementation plan can pick them up explicitly:

* **Picker "Sign out" action:** best-effort API call + always clear local state. If the API call
  fails (offline), we still clear the local cookie. Server-side session may persist briefly until it
  expires naturally.
* **Picker doesn't probe per-profile online state:** showing "last used N ago" is the affordance,
  not "this profile is online right now." Per-profile probing would require N parallel `getSession`
  attempts with different cookies, which isn't readily doable in a single Better Auth client
  instance anyway.
* **Banner click target:** routes to a sign-in sub-page pre-filled with the profile's email, then
  back to the workspace on success. Behaves like the existing sign-in form, scoped to one profile.
* **First-ever-launch on a device with no profiles and no network:** the empty-state sign-in form
  renders but submit will fail. That's the same outcome as today; the picker doesn't improve it (you
  can't sign in offline). The form should surface the network error clearly, but designing that
  affordance is out of scope here.
* **`/signin` URL back-compat:** redirect to `/profiles`. Better Auth's internal `callbackURL`
  values that may reference `/signin` continue to work via the redirect.

## Out of scope (future work)

* Per-profile passcode lock (privacy on borrowed devices).
* Cross-tab profile-switch coordination (today each tab is independent; if user switches in one tab,
  others stay on the old profile until reload — acceptable).
* Mobile (iOS/Android) Tauri builds — design is platform-agnostic but Android specifically needs an
  `android-x86_64`/`aarch64` matrix entry in the release workflow, which is a separate workstream.
* Account merging (two profiles representing the same server account, somehow drifted apart).
* Sign-in with a deep-link from a different app/browser (OAuth bounce from a Tauri-external browser
  back into the Tauri window).
