# Server API

HTTP contract exposed by `@verse-vault/api`. JSON in, JSON out; cookie-based auth via Better Auth.
All `/api/*` routes except `/api/auth/*` require a valid Better Auth session cookie (401 otherwise).
`Content-Type: application/json` on every request with a body.

## Thin vs. fat

Two parallel route surfaces sit on top of the same engine + event log:

* **Fat client** (`/api/sync/*`) — server returns the snapshot + test states; the client runs the
  engine locally and uploads batched events on reconnect. _Drives the Vue web app today._
* **Thin client** (`/api/cards/*`) — server picks the next card, server replays the grade. _Legacy;
  kept for tests + ad-hoc tooling. No view consumes it now._

Both paths go through the same `EngineStore.withLock(key, …)` serialisation per `(user, material)`
and write to the same `review_events` table with `clientEventId` dedup. See
[`persistence.md`](persistence.md) for the storage layer and [`wasm-api.md`](wasm-api.md) for the
wire shapes the engine emits.

## Auth — `/api/auth/*` (Better Auth)

Mounted by Better Auth's request handler — all routes the library exposes (sign-in, sign-up,
session, OAuth callbacks, password reset, …) live under this prefix. Configured providers and flows
depend on the env vars set on the server (`GOOGLE_CLIENT_ID`, etc. — see
[`deployment.md`](deployment.md)). Sessions are HTTP-only cookies.

Useful endpoints (Better Auth defaults):

| method | path                                | purpose                                          |
| ------ | ----------------------------------- | ------------------------------------------------ |
| GET    | `/api/auth/get-session`             | current session or null                          |
| POST   | `/api/auth/sign-in/email`           | password sign-in                                 |
| POST   | `/api/auth/sign-out`                | clear session cookie                             |
| GET    | `/api/auth/callback/<provider>`     | OAuth provider callback (per provider config)    |
| POST   | `/api/auth/request-password-reset`  | `{ email }`; emails a reset link                 |
| POST   | `/api/auth/reset-password`          | `{ token, newPassword }`; sets the password      |
| GET    | `/api/auth/verify-email`            | `?token=`; verifies, with that account's session |
| POST   | `/api/auth/send-verification-email` | `{ email }`; emails a new verification link      |
| POST   | `/api/auth/link-social`             | connects Google to the signed-in account         |

### Password reset

`POST /api/auth/request-password-reset` answers `200 { status: true, message }` for every address,
and Better Auth does dummy work for an unknown one so the reply takes as long. The email is sent
from `no-reply@versevault.ca` through Resend (`RESEND_API_KEY`; without it the API logs the link
instead). The send starts and the request returns without waiting for it, so a real address isn't
measurably slower, and a failed send is logged rather than surfaced.

The link opens the web app at `<WEB_BASE_URL>/reset-password?token=…`, never the requesting client's
own origin, since a desktop client's `tauri://` origin means nothing to a browser. The page posts
the token with the new password to `POST /api/auth/reset-password`, which answers `400` with
`INVALID_TOKEN` for an unknown, used, or expired token. A token is valid for one hour and works
once.

Completing a reset:

* ends every session for the account on every device;
* marks the address verified, since receiving the email proves the inbox;
* deletes the account's other outstanding reset tokens, so an older link can't be used later.

An account with only Google sign-in gets its first password this way.

### Email verification

Signing up with a password sends a verification email; the account works before it is verified, and
nothing requires verification to sign in. Google sign-ups arrive verified when Google is
authoritative for the address (below). A verified address is what lets Google sign-in link into a
password account (see `accountLinking` in `packages/api/src/lib/auth.ts`).

The link opens the web app at `<WEB_BASE_URL>/verify-email?token=…&email=…`. The page makes the
link's account the active session, switching profile or asking for sign-in, then calls
`GET /api/auth/verify-email?token=…` with that session and no `callbackURL`, so the answer is JSON:

* `200` and the address is verified, when the session belongs to the token's account;
* `403`, verifying nothing, for no session or another account's session;
* `401` with `TOKEN_EXPIRED`, `INVALID_TOKEN`, or `USER_NOT_FOUND` for a bad token.

The session requirement is deliberate. Better Auth's verify route only sets the flag, so verifying
from a signed-out click would let someone who registered another person's address get that person to
verify it from the genuine email, leaving the registrant's password on an account that then accepts
the owner's Google sign-in. Signing in proves the password; the email proves the inbox.

Tokens are signed and not stored, valid for 24 hours, and can be used again within that time, which
only re-sets a flag already set. A learner signs in and asks for a new link with
`POST /api/auth/send-verification-email`, which answers the same way for every address.

### Google sign-in and the address

Google's `email_verified` claim is trusted only where Google hosts the mail: an `@gmail.com` or
`@googlemail.com` address, or a Workspace account, whose ID token carries an `hd` claim naming the
organization's domain. That follows Google's own guidance ("Verify the Google ID token on your
server side"): for any other address Google checked ownership once, when the Google account was
created, and the address may since have changed hands. The Google provider's `mapProfileToUser` in
`packages/api/src/lib/auth.ts` applies the rule, and Better Auth uses the result everywhere it
trusts Google's address:

* a Google sign-in links into an existing account only when that account is verified and Google is
  authoritative; otherwise it is refused with `?error=account_not_linked`, except for the choice
  below;
* a new Google sign-up starts verified only when Google is authoritative.

### Google sign-in onto a password account

* **Verified account, Google authoritative**: the Google sign-in links and signs in.
* **Google not authoritative**: refused with `?error=account_not_linked`.
* **Unverified account, Google authoritative**: Better Auth refuses with `account_not_linked`, and
  an after hook on the callback turns that into a redirect to
  `/profiles?force=1&pending=<token>&email=…` on the origin of the client's `errorCallbackURL`. The
  token names a `pending-google:*` verification row holding the user id, the Google `sub`, and the
  address, valid for 10 minutes. The Google profile reaches the hook through Better Auth's request
  state, set in `mapProfileToUser`.

The picker then asks whether the account is the learner's, and acts through one of two routes. Both
consume the token once and answer every used, expired, or unknown token with the same
`400 { error }`.

* `POST /api/account/google/claim` `{ token }` ("That's me"), with the session from signing in with
  the account's password: links the Google `sub`, keeps the password, and verifies. `403` when the
  session belongs to a different account.
* `POST /api/account/google/takeover` `{ token }` ("That's not me"), no session: refuses an account
  verified since the token was issued, then deletes the password and every session (as Better Auth's
  `revokeUnprovenAccountAccess` does), links the Google `sub`, and verifies. The client then signs
  in with Google again, which now finds the account linked.

Connecting Google from account settings (`POST /api/auth/link-social`) needs a session and a Google
account with the same address, for which Google is authoritative. Better Auth's link route doesn't
verify the address, so the same callback after hook does, when the account now holds that Google
identity.

### `GET /api/me`

Returns the current user. Shortcut over `/api/auth/get-session` that's tighter than the Better Auth
shape:

```json
{ "user": { "id": "...", "email": "...", "name": "..." } }
```

### `GET /health`

Unauthenticated. Returns `{ "status": "ok" }`. Useful for uptime probes.

## Cards — `/api/cards/*`

Thin-client surface: the server holds the engine, picks the next card, renders it, accepts a grade,
returns updates + the next card.

### `GET /api/cards/review/next?materialId=...`

Returns the id of the next card the scheduler wants reviewed, or null if every card is currently
above target retention (and the sibling cooldown is satisfied).

```json
{ "cardId": 42 }              // or { "cardId": null }
```

### `GET /api/cards/memorize/session?materialId=...&max=N`

Returns the next batch of verses to memorise. `max` is clamped to `[1, 50]` (default `1`).

```json
{
  "verses": [
    { "verseId": 12, "cardIds": [101, 102, 103, ...], "recitationCardId": 110 }
  ]
}
```

`cardIds` are the per-verse drill cards in builder order; `recitationCardId` is the verse's
Recitation card (or null), used as the anchor render for the session's opening + closing
walkthroughs.

### `GET /api/cards/:cardId?materialId=...`

Returns everything needed to render a card prompt: the structural wire payload from the engine plus
optional `composed` HTML layered from the api.bible cache.

```json
{
  "cardId": 42,
  "verseId": 0,
  "kind": "PhraseFill",
  "position": 1,
  "verse": { /* VerseRender — see wasm-api.md */ },
  "composed": {
    "phraseHtml": ["<span>…</span>", "…"],
    "ftvHtml": null,
    "headings": [{ "headingIdx": 0, "title": "…" }]
  }
}
```

`composed` is `null` when the api.bible cache is unavailable (e.g. `BIBLE_API_KEY` unset). The
client can still render the prompt from the structural data; just without NKJV text.

### `POST /api/cards/review`

Submit a grade. The server replays the event into the cached engine, persists the touched
`test_states` rows + an entry in `review_events` in a single transaction, and returns the engine's
update list plus the next card id.

Request:

```json
{ "materialId": "nkjv-1cor", "cardId": 42, "grade": 3 }
```

Response:

```json
{
  "updates": [ /* TestUpdateWire[] — see wasm-api.md */ ],
  "nextCardId": 43
}
```

`grade` is `1=Again, 2=Hard, 3=Good, 4=Easy`. `clientEventId` is generated server-side as a UUID;
the thin path doesn't need clients to supply one.

### `POST /api/cards/memorize/graduate`

Flips a verse's cards from `New` to `Active`, recording a row in `graduated_verses`. Idempotent —
re-graduating a graduated verse is a no-op.

Request:

```json
{ "materialId": "nkjv-1cor", "verseId": 12 }
```

Response:

```json
{ "graduated": 1 }   // 1 = newly graduated, 0 = already was
```

## Sync — `/api/sync/*`

Fat-client surface. The client hydrates from `/state`, runs reviews offline, uploads batches to
`/events` on reconnect. Both endpoints share the same data layer as the thin-client routes, so a
client can mix the two on a single device (a fat client that posts to `/sync/.../events` while
elsewhere the same user is reviewing via `/cards/review` on another tab will serialise correctly
through `engines.withLock`).

The server takes every event a client offers (constitution principle VI). An event it cannot apply
now is stored with its reason in `pending_events` and reported back, never refused, so a device with
a working connection always drains its outbox and can be wiped without losing work. The design
record is `specs/002-resilient-sync-ingest/`.

### `GET /api/sync/:materialId/state`

Hydrate a fresh client. Returns the latest snapshot, every persisted test state, the most recent
event id, the graduation logs, the state fingerprint, and any open stale-merge question.

```json
{
  "snapshot": {
    "version": 3,
    "materialData": { /* parsed MaterialData JSON, see wasm-api.md */ }
  },
  "testStates": [ /* TestStateEntry[] */ ],
  "lastEventId": "01HXX...",
  "graduatedVerseIds": [17],
  "graduatedCardIds": [684032],
  "stateRev": "a1b2c3d4",
  "pendingConfirmation": null
}
```

`pendingConfirmation` is `null`, or the summary of a batch held awaiting the learner's merge answer
(same shape as `staleSummary` below). It is read from the server, so any device can raise the
question, including one wiped after the upload that opened it. `GET /api/years` carries the same
field per enrolled year, for clients that boot from a cached snapshot and never call `/state`.

404 if the user isn't enrolled in the material: this reads state that does not exist, and refuses no
work.

### `POST /api/sync/:materialId/events`

Upload a batch. The client supplies a `clientEventId` per event so retries are idempotent. Batch
size is capped at 500 per request; a client with more uploads in pages until its outbox is empty.

Request:

```json
{
  "events": [
    {
      "kind": "review",
      "clientEventId": "...uuid...",
      "timestampSecs": 1747600000,
      "snapshotVersion": 3,
      "cardId": 42,
      "grade": 3
    },
    {
      "kind": "graduate",
      "clientEventId": "...uuid...",
      "timestampSecs": 1747600005,
      "snapshotVersion": 3,
      "verseId": 17
    }
  ],
  "confirmMerge": false
}
```

Event kinds:

* `review`: replays through `engine.replay_event(cardId, grade, …)`. Required fields: `cardId`,
  `grade` (1=Again, 2=Hard, 3=Good, 4=Easy).
* `graduate`: calls `engine.graduate_verse(verseId)` and upserts a `graduated_verses` row in the
  same transaction. Required field: `verseId`.
* `graduateCard`: calls `engine.graduate_card(cardId)` and upserts a `graduated_cards` row. Required
  field: `cardId`.
* Events without a `kind` field default to `review` for backward compatibility with the original
  thin-client wire shape.

`confirmMerge: true` survives for older clients only: it answers the stale-merge question by
re-sending the batch (see below). A current client answers through `POST .../confirm`.

Response:

```json
{
  "accepted": 49,
  "duplicates": 1,
  "rebuilt": false,
  "testStates": [ /* TestStateEntry[], full set after replay */ ],
  "lastEventId": "01HXX...",
  "stateRev": "a1b2c3d4",
  "dispositions": [
    { "index": 0, "clientEventId": "0179058f-...", "disposition": "applied" },
    { "index": 1, "clientEventId": "0455c893-...", "disposition": "unusable", "reasonCode": "card-unknown", "reason": "card id 7578 is not produced by any config for this deck" },
    { "index": 2, "clientEventId": "27915966-...", "disposition": "pending", "reasonCode": "card-not-emitted", "reason": "card id 71 is not emitted by the current config" },
    { "index": 3, "clientEventId": "4083429a-...", "disposition": "duplicate" },
    { "index": 4, "clientEventId": null, "disposition": "unusable", "reasonCode": "malformed", "reason": "clientEventId must be a non-empty string" }
  ]
}
```

Every event in the request appears exactly once in `dispositions`, identified by its `index`;
`clientEventId` is echoed when the event carried a readable one. `accepted` and `duplicates` count
only applied and already-known events, so an older client reading just those behaves as before.
Graduate events whose `engine.graduate_verse()` returned 0 (the verse was already Active) are
counted as duplicates.

| Disposition | Meaning                                                          | Where it lives                          |
| ----------- | ---------------------------------------------------------------- | --------------------------------------- |
| `applied`   | Changed the learner's state                                      | `review_events` or `graduated_*`        |
| `duplicate` | The server already held it                                       | Unchanged, in whichever table held it   |
| `pending`   | May apply later                                                  | `pending_events`, `status = 'pending'`  |
| `unusable`  | Will not apply as things stand; a shipped repair may change that | `pending_events`, `status = 'unusable'` |

| Reason code             | Status     | Leaves pending when                                    |
| ----------------------- | ---------- | ------------------------------------------------------ |
| `card-not-emitted`      | `pending`  | An engine build finds the config emits the card again  |
| `not-enrolled`          | `pending`  | The account enrols in the material                     |
| `awaiting-confirmation` | `pending`  | The learner answers the merge question                 |
| `card-unknown`          | `unusable` | A shipped repair turns it into an id some config emits |
| `malformed`             | `unusable` | A shipped repair turns it into a well-formed event     |

`card-not-emitted` versus `card-unknown` is the engine's call: an id the learner's engine lacks is
checked against an engine built from core's `MaterialConfig::max_emission()`, the config that emits
every card any config can. `reason` is prose for operators; clients must not parse it.

A malformed event is taken, not refused: a missing or empty `clientEventId`, a non-integer or
negative `timestampSecs`, one more than 24h in the future (a broken device clock would otherwise
insert events at arbitrary positions in the timeline), `snapshotVersion < 1`, a negative or
non-integer `cardId` or `verseId`, `grade ∉ {1,2,3,4}`, an unknown `kind`, or an entry that is not
an object. A client that could not hand over its junk could never empty its outbox.

**Client obligation.** On any 200 the client deletes every event the request carried, whatever the
dispositions say. They are information, not instructions; this is what lets an event whose
`clientEventId` the server could not read still leave the outbox.

**Stale merge.** When the batch's oldest applicable event predates more than `STALE_MERGE_THRESHOLD`
already-applied server events and `confirmMerge !== true`, the learner is asked before it merges,
because an old batch can drag down FSRS stability on cards reviewed since. The batch is taken first,
as `pending` / `awaiting-confirmation`, and the normal response adds:

```json
{
  "needsConfirm": true,
  "staleSummary": {
    "queuedCount": 50,
    "serverEventsSince": 3000,
    "oldestQueuedTs": 1700000000,
    "newestServerTs": 1747600000
  }
}
```

The client still deletes the batch; the question is the server's to hold, and `POST .../confirm`
answers it. An older client that keeps its outbox and re-sends it with `confirmMerge: true` has
those held events merged and reported `applied`.

Side effects (atomic, one transaction):

* Appends applied reviews to `review_events`.
* For `graduate` / `graduateCard` events: upserts `graduated_verses` / `graduated_cards` rows
  (`onConflictDoNothing`).
* Inserts every event taken but not applied into `pending_events`, with its payload verbatim.
* Upserts touched rows in `test_states`.
* On out-of-order arrival (an incoming review's `timestampSecs` is earlier than any already applied
  for the same `card_id`): drops the cached engine, replays the full `review_events` log in
  `(timestamp_secs, client_event_id)` order through a fresh engine, writes the resulting
  `test_states` back wholesale, and returns `rebuilt: true`. The client treats this as a wholesale
  state replacement rather than a merge.
* If the transaction itself throws, the cached engine is invalidated so the next request rebuilds
  from disk state.

Each request that stores anything unapplied logs one `sync.events_not_applied` line naming each
event, its status, reason code and reason, with the requestId.

The request as a whole can still be refused, but only for reasons that strand nothing:

* **400** when the body is not a JSON object with an `events` array. It carries no events to take.
* **401** when not signed in. Signing in resumes the upload with nothing lost.
* **409** when a well-formed event's `snapshotVersion` is behind. The events are fine, only their
  stamp is stale: the client re-fetches `/state`, re-stamps its queue, and uploads again.
* **404** when the material is not in the catalogue. No event for it can ever apply, so there is
  nothing to hold.
* **413** when more than 500 events arrive in one request, or the body exceeds 1 MiB. A page size,
  not a verdict; a full page of real events is about 125 KB.

An upload for a material the account is not enrolled in is taken as `pending` / `not-enrolled`, not
refused, and applies at the first engine build after the account enrols.

### `POST /api/sync/:materialId/confirm`

Answer an open stale-merge question.

```json
{ "decision": "merge" }
```

* `merge`: every `awaiting-confirmation` event for this account and material is re-judged by the
  upload's rule, then applied at its recorded time, and the engine is rebuilt from the log. An event
  whose card the learner has switched off since keeps waiting as `card-not-emitted`; one no config
  emits any more becomes `unusable`. Responds like an upload, without `dispositions`.
* `discard`: every such event becomes `status = 'discarded'`. Nothing is deleted. Responds
  `{ "discarded": 57 }`.

Answering with no open question is a 200 no-op with zero counts, so a question answered on another
device first is not an error. 400 for any other `decision`; 404 if not enrolled.

### Held events

Engine build (`EngineStore.load` and `rebuildFromEvents`) re-judges `card-not-emitted` and
`not-enrolled` rows with the same rule the upload uses. One whose card the engine now emits is
written to its real table at its recorded time; a promoted review sends `load` through a rebuild so
it replays in order. One whose card no config emits any more becomes `unusable` / `card-unknown`.
The common case of nothing held costs one indexed probe. `awaiting-confirmation` rows wait for the
learner.

Before promoting, the build offers shipped repairs to `unusable` rows not yet offered this set of
repairs. One that yields a well-formed event with an emittable card makes the row `pending`, and it
promotes in the same build if its card is emitted. See [`persistence.md`](persistence.md) for how
repairs are recorded.

## Materials — `/api/materials/*`

### `GET /api/materials/`

Lists the materials the server knows about (decks bundled in `data/`). Doesn't reveal enrollment
state; pair with `/years` for per-material status.

```json
{ "materials": [ { "id": "nkjv-1cor", "title": "1 Corinthians", "description": "..." } ] }
```

### `POST /api/materials/enroll`

Enrolls the current user in a material. Idempotent at the user-error level (409 if already enrolled
— use `/api/years/:materialId/settings` to change a scope on an existing enrollment).

Request:

```json
{ "materialId": "nkjv-1cor", "clubTier": 300 }   // clubTier: 150 | 300 | null
```

Response:

```json
{ "materialId": "nkjv-1cor", "snapshotId": "...", "version": 1 }
```

### `GET /api/materials/:id/status`

Per-material enrollment summary:

```json
{ "materialId": "nkjv-1cor", "clubTier": 300, "testCount": 1247 }
```

`testCount` is the number of persisted `test_states` rows — proxies "how much progress is on file."

## Years — `/api/years/*`

The material picker. `years` is a misnomer left over from the original deck-per-year naming; returns
one row per material the user can interact with (enrolled or not).

### `GET /api/years/`

Returns every material plus per-tier counts and the user's current scope settings. Drives the
material-picker UI.

```json
{
  "years": [
    {
      "materialId": "nkjv-1cor",
      "title": "1 Corinthians",
      "description": "...",
      "enrolled": true,
      "offlineMode": false,
      "settings": {
        "headingCard": false,
        "headingPassageCard": true,
        "ftv": true,
        "newScope": "up300",
        "reviewScope": "all",
        "clubCardScope": "up300",
        "chapterListScope": "up150",
        "lessonBatchSize": 5,
        "desiredRetention": 0.8
      },
      "perClub": {
        "memorize": { "150": { "enabled": true, "catchUp": "sequential" }, "...": {} },
        "review": { "150": { "enabled": true, "desiredRetention": 0.8 }, "...": {} },
        "moveToNext": { "p150To300": "caughtUp", "p300ToFull": "caughtUp" }
      },
      "clubs": {
        "150": { "status": "active", "cardCount": 312 },
        "300": { "status": "maintenance", "cardCount": 580 },
        "full": { "status": "paused", "cardCount": 0 }
      },
      "newCardCount": 87,
      "memorizeDebt": { "verses": 13, "cards": 124 },
      "stateRev": "a1b2c3d4",
      "pendingConfirmation": null
    }
  ]
}
```

`newCardCount` is every card still in `New` — the whole remaining pool. `memorizeDebt` is the
schedule-aware slice of it: un-memorized verses the year's schedule introduced in weeks
`0..=current_week` in every club with memorize enabled, plus the cards they carry
(`core::schedule::memorize_debt`). The cross-club gates don't shrink it: being behind on Club 300
does not take this week's Full verses out of the count. Years with no schedule, or whose season
hasn't started, report those clubs' whole un-memorized pool; unenrolled years report zeroes. Added
in api 0.1.39 — clients that may reach an older server should fall back to `newCardCount`.

`pendingConfirmation` is the year's open stale-merge question, or `null`; absent for unenrolled
years. It is the same summary `GET /api/sync/:materialId/state` returns, carried here because a
client booting from its cached snapshot never calls `/state` and would otherwise never hear of a
question another device opened. Added in api 0.1.40.

### `POST /api/years/:materialId/settings`

Update the user's scope toggles for a material. Auto-enrolls if `newScope` or `reviewScope` is
bumped above `off` and the user isn't yet enrolled. Invalidates the in-memory engine for the key on
success so the next `/cards/*` call rebuilds.

Request body is a partial `YearSettings`:

```json
{ "newScope": "up300", "headings": true }
```

Response returns the full updated settings:

```json
{ "settings": { "headings": true, "ftv": false, "newScope": "up300", ... } }
```

## Stats — `/api/stats/:materialId`

Per-material progress dashboard payload. Returns retention rate (passes / total grades over all
`review_events`), the number of verses with at least one Familiar+ test, and a stability histogram
over `test_states`:

```json
{
  "materialId": "nkjv-1cor",
  "versesLearned": 84,
  "retentionRate": 0.91,
  "totalGrades": 1432,
  "testDistribution": {
    "weak": 410,
    "learning": 230,
    "familiar": 180,
    "strong": 120,
    "mastered": 95
  }
}
```

Stability buckets (days): `weak < 1`, `learning [1, 7)`, `familiar [7, 30)`, `strong [30, 90)`,
`mastered >= 90`.

## Account data — `/api/export`, `/api/import`, `/api/account/progress`

Account-level data portability + reset. All require the session cookie.

### `GET /api/export`

Full account dump — every enrolled material with its settings, graduations, and review events — as a
downloadable `AccountExport` JSON
(`Content-Disposition: attachment; filename="verse-vault-export-YYYY-MM-DD.json"`). Cards key on
`CardRef` (`kind` + verseId + params), not `cardId`, so the payload survives snapshot bumps.

### `POST /api/import`

Apply an `AccountExport` to the caller's account. Additive and idempotent: review events dedup on
`clientEventId`, graduations `onConflictDoNothing`, settings merge by `max(updatedAt)`. Returns an
`ImportSummary`:

```json
{ "materialsApplied": 8, "eventsInserted": 41608, "eventsSkipped": 0, "graduationsApplied": 631, "unresolvedCardRefs": 329 }
```

400 on an unsupported `exportVersion`, unknown `materialId`, or out-of-bounds settings; 413 if the
body exceeds the 50 MB cap.

### `DELETE /api/account/progress`

Wipe the caller's review events, graduations, and derived `test_states` across every enrolled
material (each under `engines.withLock`). Keeps enrollments, per-year settings, and the content
snapshot — decks stay, reset to all-new. Idempotent. Returns:

```json
{ "materialsReset": 8, "eventsDeleted": 41608, "graduationsDeleted": 631 }
```

## Status codes

| status | when                                                                                                                                                     |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | malformed JSON, missing required field, invalid `grade`, invalid scope value, …                                                                          |
| 401    | no session cookie / expired session                                                                                                                      |
| 404    | material id unknown, or caller not enrolled in the requested material, or card id unknown (a sync upload 404s only for a material outside the catalogue) |
| 409    | sync batch uses a stale `snapshotVersion`, or already-enrolled on `/enroll`                                                                              |
| 413    | sync batch exceeds the 500-event cap                                                                                                                     |
| 429    | rate limit exceeded; `Retry-After` header carries integer seconds until next allowed request                                                             |
| 500    | engine threw on `replay_event` / `get_card_render` (unknown card id, malformed state) — caller's bug                                                     |

All error bodies follow `{ "error": "..." }`.

## Rate limiting

The API runs an in-memory token-bucket per client IP. Defaults:

| tier                 | limit       | applies to                                                                                                        |
| -------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------- |
| authed               | 120 req/min | every route except `/health` and the credential surfaces below — includes cheap `/api/auth/*` session-state reads |
| unauthed (auth-flow) | 10 req/min  | credential surfaces under `/api/auth/*` (sign-in, sign-up, password reset, OAuth callbacks, sign-out, etc.)       |
| exempt               | —           | `/health` (no bucket, no 429)                                                                                     |

Cheap session-state reads (`GET /api/auth/get-session`,
`GET /api/auth/multi-session/list-device-sessions`) are explicitly allowlisted onto the looser
`authed` tier — the web client hits them on every app boot and every route navigation, and dumping
that volume into the credential-stuffing bucket 429'd normal nav long before any attack-shaped
traffic. Add new paths to `AUTH_LOOSE_PATHS` in `packages/api/src/middleware/observability.ts` when
a future Better Auth route lands in the same shape.

Bucket key is the client IP (`CF-Connecting-IP` in production behind the Cloudflare Tunnel,
`X-Forwarded-For` first hop in dev, `unknown` if neither is present). In local dev, `ip:unknown`
skips the bucket entirely — localhost requests carry no proxy header, so without the skip every
unauthenticated request shares one bucket and a couple of refreshes exhaust it. Toggle the skip via
`rateLimitUnknownIp` (defaults to `NODE_ENV === 'production'`); prod still limits unknown IPs as a
defense-in-depth measure since a real `ip:unknown` request behind the Tunnel is a misconfig or a
header-spoof bypass attempt. Per-user keying is a follow-up if NAT'd users start tripping limits —
siblings sharing a NAT currently share a bucket.

Failed Better Auth attempts (e.g. 401 from `/api/auth/sign-in/email` with a bad password) still
consume a token. That's intentional brute-force protection.

Two more limits sit inside Better Auth (`packages/api/src/lib/auth.ts`):

* **Better Auth's own per-IP limits**, on in production only, including 3 per minute on
  `/request-password-reset` and `/send-verification-email`. It reads the client IP from
  `CF-Connecting-IP`, then `X-Forwarded-For`; with neither it would key every client to one shared
  bucket.
* **Per address**: at most 3 requests an hour for any one address, across reset and verification
  emails together, keyed by the lowercased `email` in the body. It counts requests, not emails sent,
  so throttling looks the same whether or not the address has an account. Over the limit:
  `429 { code: "TOO_MANY_REQUESTS", message }` with `Retry-After`. The bucket lives in memory and
  resets on restart, which is fine for an abuse guard. Sign-up's own verification email isn't
  counted; sign-up can't repeat for an address.
* **Per IP per day**: at most 10 emails per client IP a day, so one client can't spend the email
  provider's daily quota. Requests to `/request-password-reset` and `/send-verification-email` count
  when they arrive, once they pass the per-address limit; over the limit they get the same 429 shape
  with "Too many requests from this network." A sign-up, with a password or with Google, counts only
  once its account is created, and over the limit it succeeds without sending the verification email
  (logged as `[email] sign-up verification skipped`), so a group on one network is never refused.
  Shares the per-address limit's in-memory store.

Tuneable via env vars at boot:

* `RATE_LIMIT_AUTHED_PER_MIN` — default 120.
* `RATE_LIMIT_UNAUTHED_PER_MIN` — default 10.

Garbage values (non-integer, non-positive) fall back to the defaults. Limits are per single API
instance with no distributed coordination; a horizontal scale-out will need a shared store.

## Request logging

Every non-`OPTIONS` request emits one JSON-line log to stdout (captured into journald via the
systemd unit). Shape:

```json
{
  "requestId": "uuid-v4",
  "userId": "user-id or null",
  "ip": "1.2.3.4 or 'unknown'",
  "method": "GET",
  "path": "/api/cards/...",
  "status": 200,
  "durationMs": 47
}
```

Additional fields when present: `rateLimited: true` on a 429, `error: "<message>"` when a handler
threw. The `requestId` is also returned on every response in the `X-Request-Id` header so clients
can quote it in support requests. `OPTIONS` preflights are intentionally not logged.
