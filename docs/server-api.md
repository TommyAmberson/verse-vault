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

| method | path                            | purpose                                       |
| ------ | ------------------------------- | --------------------------------------------- |
| GET    | `/api/auth/get-session`         | current session or null                       |
| POST   | `/api/auth/sign-in/email`       | password sign-in                              |
| POST   | `/api/auth/sign-out`            | clear session cookie                          |
| GET    | `/api/auth/callback/<provider>` | OAuth provider callback (per provider config) |

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

### `GET /api/sync/:materialId/state`

Hydrate a fresh client. Returns the latest snapshot + every persisted test state + the most recent
event id (so the client can know where to resume).

```json
{
  "snapshot": {
    "version": 3,
    "materialData": { /* parsed MaterialData JSON — see wasm-api.md */ }
  },
  "testStates": [ /* TestStateEntry[] */ ],
  "lastEventId": "01HXX..."
}
```

404 if the user isn't enrolled in the material.

### `POST /api/sync/:materialId/events`

Upload a batch. The client supplies a `clientEventId` per event so retries are idempotent. Batch
size is capped at 500 (413 otherwise — keeps the dedup `inArray` under SQLite's 999-param limit).

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

* `review` — replays through `engine.replay_event(cardId, grade, …)`. Required fields: `cardId`,
  `grade` (1=Again, 2=Hard, 3=Good, 4=Easy).
* `graduate` — calls `engine.graduate_verse(verseId)` and upserts a `graduated_verses` row in the
  same transaction. Required field: `verseId`.
* Events without a `kind` field default to `review` for backward compatibility with the original
  thin-client wire shape.

`confirmMerge: true` bypasses the stale-merge preflight (see below). Defaults to `false`.

Validation rejects (400) with these conditions:

* `timestampSecs > server_now + 24h` (clock-skew guard — a broken device RTC could otherwise insert
  events at arbitrary positions in the timeline).
* `clientEventId` missing/empty, `snapshotVersion < 1`, `cardId < 0`, `grade ∉ {1,2,3,4}`,
  `verseId < 0`, or an unknown `kind`.

Response — normal merge:

```json
{
  "accepted": 12,
  "duplicates": 0,
  "rebuilt": false,
  "testStates": [ /* TestStateEntry[] — full set after replay */ ],
  "lastEventId": "01HXX..."
}
```

Response — stale-merge preflight (when the batch's oldest event predates more than
`STALE_MERGE_THRESHOLD` already-applied server events and `confirmMerge !== true`):

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

No events are applied in the preflight response. The client surfaces a confirmation prompt and
re-POSTs the same batch with `confirmMerge: true` to proceed, or discards locally.

Side effects (atomic, one transaction):

* Appends accepted events to `review_events`.
* For `graduate` events: upserts `graduated_verses` rows (`onConflictDoNothing`).
* Upserts touched rows in `test_states`.
* On out-of-order arrival (an incoming review's `timestampSecs` is earlier than any already applied
  for the same `card_id`): drops the cached engine, replays the full `review_events` log in
  `(timestamp_secs, client_event_id)` order through a fresh engine, writes the resulting
  `test_states` back wholesale, and returns `rebuilt: true`. The client treats this as a wholesale
  state replacement rather than a merge.
* If the transaction itself throws, the cached engine is invalidated so the next request rebuilds
  from disk state (the handler calls `engine.replay_event` / `engine.graduate_verse` before the
  transaction, so the in-memory engine would otherwise diverge from `review_events` +
  `graduated_verses` until process restart).

Snapshot-version mismatch returns 409 — the client must re-fetch `/state` and rebuild its local
engine before retrying. A duplicate `clientEventId` is silently dropped (counted under
`duplicates`); the rest of the batch still applies. Graduate events whose `engine.graduate_verse()`
returned 0 (the verse was already Active before this batch) are counted as duplicates too.

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
      "settings": {
        "headings": true,
        "ftv": false,
        "newScope": "up300",
        "reviewScope": "all",
        "clubCardScope": "up300",
        "chapterListScope": "up150",
        "lessonBatchSize": 5
      },
      "clubs": {
        "Club150": { "status": "active", "totalVerses": 312, "newVerses": 42 },
        "Club300": { "status": "maintenance", "totalVerses": 580, "newVerses": 0 }
      },
      "newCardCount": 87
    }
  ]
}
```

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

| status | when                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------- |
| 400    | malformed JSON, missing required field, invalid `grade`, invalid scope value, …                      |
| 401    | no session cookie / expired session                                                                  |
| 404    | material id unknown, or caller not enrolled in the requested material, or card id unknown            |
| 409    | sync batch uses a stale `snapshotVersion`, or already-enrolled on `/enroll`                          |
| 413    | sync batch exceeds the 500-event cap                                                                 |
| 429    | rate limit exceeded; `Retry-After` header carries integer seconds until next allowed request         |
| 500    | engine threw on `replay_event` / `get_card_render` (unknown card id, malformed state) — caller's bug |

All error bodies follow `{ "error": "..." }`.

## Rate limiting

The API runs an in-memory token-bucket per client IP. Defaults:

| tier                 | limit       | applies to                                        |
| -------------------- | ----------- | ------------------------------------------------- |
| authed               | 120 req/min | every route except `/health` and the two below    |
| unauthed (auth-flow) | 10 req/min  | `/api/auth/*` — defangs credential-stuffing loops |
| exempt               | —           | `/health` (no bucket, no 429)                     |

Bucket key is the client IP (`CF-Connecting-IP` in production behind the Cloudflare Tunnel,
`X-Forwarded-For` first hop in dev, `unknown` if neither is present). Per-user keying is a follow-up
if NAT'd users start tripping limits — siblings sharing a NAT currently share a bucket.

Failed Better Auth attempts (e.g. 401 from `/api/auth/sign-in/email` with a bad password) still
consume a token. That's intentional brute-force protection.

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
