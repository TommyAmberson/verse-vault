# Server API

HTTP contract exposed by `@verse-vault/api`. JSON in, JSON out; cookie-based sessions via
[Better Auth](https://www.better-auth.com). Unless noted, all non-auth endpoints require a valid
session cookie (401 otherwise).

## Auth — `/api/auth/*`

Handled by Better Auth directly. See the [Better Auth docs](https://www.better-auth.com/docs) for
the full surface; the ones we rely on today:

| Method | Path                        | Purpose                      |
| ------ | --------------------------- | ---------------------------- |
| POST   | `/api/auth/sign-up/email`   | register with email+password |
| POST   | `/api/auth/sign-in/email`   | log in                       |
| POST   | `/api/auth/sign-out`        | log out                      |
| GET    | `/api/auth/session`         | current session or null      |
| GET    | `/api/auth/sign-in/social`  | start Google OAuth redirect  |
| GET    | `/api/auth/callback/google` | OAuth callback               |

### `GET /api/me`

Echoes the authenticated user. Useful smoke test.

```json
{ "user": { "id": "...", "email": "alice@example.com", "name": "Alice" } }
```

## Sessions — `/api/sessions/*`

The server owns the review engine: a session is an in-memory handle on the user's `WasmEngine`. Only
one active session per (user, material) — starting a new one aborts the previous one.

Shared shapes:

```ts
SessionCard = {
  shown: number[];             // node IDs the user can see
  hidden: number[];             // node IDs they must recall (grade these)
  is_reading: boolean;          // if true, it's a reading-stage card — send grades: []
  source_kind: 'scheduled' | 'redrill' | 'new_verse';
  source_card_id: number | null;
}

Grade = { node_id: number; grade: 1 | 2 | 3 | 4 }   // 1=Again … 4=Easy

ReviewOutcome = {
  edge_updates: Array<{ edge_id: number; grade: number; weight: number }>;
  redrills_inserted: number;
}
```

### `POST /api/sessions/start`

Request:

```json
{
  "materialId": "nkjv-1cor",
  "newVerses": [{ "verse_ref": 0, "verse_phrases": [2, 3, 4] }]
}
```

`newVerses` is optional; omit to only review scheduled cards.

Response:

```json
{ "sessionId": "uuid", "card": SessionCard | null, "done": boolean }
```

`done: true` with `card: null` means there was nothing to review.

### `GET /api/sessions/:id/next`

Returns the card awaiting review, or `done: true` if the session is exhausted. Idempotent — it peeks
at the same card until a review lands.

```json
{ "sessionId": "uuid", "card": SessionCard | null, "done": boolean }
```

### `POST /api/sessions/:id/review`

Request:

```json
{ "grades": [{ "node_id": 2, "grade": 3 }] }
```

For reading-stage cards (`is_reading: true`), send `{ "grades": [] }`.

Response — outcome plus the next card (or `done: true`):

```json
{
  "outcome": ReviewOutcome,
  "sessionId": "uuid",
  "card": SessionCard | null,
  "done": boolean
}
```

Side effects (atomic, one transaction):

* Appends a row to `review_events`.
* Upserts the changed edges into `edge_states`.
* Upserts `card_states` for every card in the catalog.

When `done: true`, the session is removed from the in-memory store; a later `/next` returns 404.

### `POST /api/sessions/:id/abort`

Aborts the session — any new-verse cards that were flipped to Learning roll back to New. Returns
`{ "ok": true }`.

## Sync — `/api/sync/*`

Fat-client endpoints for offline review + catch-up. The client hydrates its local cache from
`/state`, runs reviews offline, and uploads batches to `/events` when it reconnects.

Shared shapes:

```ts
EdgeStateEntry = {
  edge_id: number;
  stability: number;
  difficulty: number;
  last_review_secs: number;
}

CardStateEntry = {
  card_id: number;
  state: 'new' | 'learning' | 'review' | 'relearning';
  due_r: number | null;
  due_date_secs: number | null;
  priority: number | null;
}

ReviewEventUpload = {
  clientEventId: string;          // client-generated UUID — idempotency key
  timestampSecs: number;
  snapshotVersion: number;
  cardId: number | null;          // null for re-drills
  shown: number[];
  hidden: number[];
  grades: Grade[];
}
```

### `GET /api/sync/:materialId/state`

Hydrate a fresh client. Returns the latest graph snapshot plus the user's materialized state.

```json
{
  "snapshot": {
    "version": 1,
    "graphData": { ... },     // parsed graph JSON
    "cardsData": [ ... ]      // parsed card catalog JSON
  },
  "edgeStates": EdgeStateEntry[],
  "cardStates": CardStateEntry[],
  "lastEventId": "uuid" | null
}
```

404 if the caller isn't enrolled in the material.

### `POST /api/sync/:materialId/events`

Upload a batch of offline review events.

Request:

```json
{ "events": ReviewEventUpload[] }
```

Response:

```json
{
  "accepted": 3,                 // new events applied
  "duplicates": 1,               // events skipped by clientEventId match
  "edgeStates": EdgeStateEntry[], // engine's full state after replay
  "cardStates": CardStateEntry[],
  "lastEventId": "uuid" | null
}
```

Side effects are a single transaction: append new events, upsert the union of changed edges, upsert
every card's state. See [persistence.md](persistence.md#upload-flow--post-apisyncmaterialidevents)
for replay semantics.

## Errors

| Status | Meaning                                                                                 |
| ------ | --------------------------------------------------------------------------------------- |
| 400    | Malformed body, missing field, or engine rejected input                                 |
| 401    | No session cookie / expired session                                                     |
| 404    | Session ID unknown / not owned by caller, or user not enrolled in the material          |
| 409    | Session found but no card awaiting review, or sync batch uses a stale `snapshotVersion` |
