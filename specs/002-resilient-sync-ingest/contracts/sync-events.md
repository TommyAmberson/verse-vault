# Contract: Sync Upload and Merge Confirmation

**Status**: target state for this feature. Current behaviour is in `docs/server-api.md`, which this
feature rewrites (FR-015).

Three routes change: the upload, the state fetch (which now reports an open confirmation question),
and a new route that answers it.

## `POST /api/sync/:materialId/events`

### Request

Unchanged.

```json
{
  "events": [
    { "kind": "review", "clientEventId": "...", "timestampSecs": 1790091633, "snapshotVersion": 2, "cardId": 684032, "grade": 2 },
    { "kind": "graduateCard", "clientEventId": "...", "timestampSecs": 1788991284, "snapshotVersion": 2, "cardId": 7578 }
  ],
  "confirmMerge": false
}
```

Batch size stays capped at 500. A client with more than that uploads repeatedly until its outbox is
empty (FR-013); the cap is not an error condition to recover from, it is a page size.

`confirmMerge` survives for older clients only (see Compatibility). A current client answers the
merge question through `POST .../confirm` instead.

### Response

One shape. The stale-merge case is no longer a separate arm: it is a normal response whose events
were taken as pending, with `needsConfirm` set.

```json
{
  "accepted": 49,
  "duplicates": 1,
  "rebuilt": false,
  "testStates": [],
  "lastEventId": "01HXX...",
  "stateRev": "a1b2c3d4",
  "needsConfirm": false,
  "dispositions": [
    { "index": 0, "clientEventId": "0179058f-...", "disposition": "applied" },
    { "index": 1, "clientEventId": "0455c893-...", "disposition": "unusable", "reasonCode": "card-unknown", "reason": "card id 7578 is not in this deck's id space" },
    { "index": 2, "clientEventId": "27915966-...", "disposition": "pending", "reasonCode": "card-not-emitted", "reason": "card id 71 is not emitted by the current config" },
    { "index": 3, "clientEventId": "4083429a-...", "disposition": "duplicate" },
    { "index": 4, "clientEventId": null, "disposition": "unusable", "reasonCode": "malformed", "reason": "clientEventId must be a non-empty string" }
  ]
}
```

When the batch predates more than the stale-merge threshold of server history, and the request did
not carry `confirmMerge: true`, every fresh event is taken as `pending` with reason code
`awaiting-confirmation`, and the response adds:

```json
{
  "needsConfirm": true,
  "staleSummary": { "queuedCount": 57, "serverEventsSince": 212, "oldestQueuedTs": 1788991284, "newestServerTs": 1790091633 }
}
```

`accepted` and `duplicates` keep their current meaning and count only applied and already-known
events, so an older client reading just those numbers behaves as it does today.

### Dispositions

| Value       | Meaning                                                          | Server state                                   |
| ----------- | ---------------------------------------------------------------- | ---------------------------------------------- |
| `applied`   | Changed the learner's state                                      | Row in `review_events` or `graduated_*`        |
| `duplicate` | The server already held it                                       | Unchanged                                      |
| `pending`   | May apply later                                                  | Row in `pending_events`, `status = 'pending'`  |
| `unusable`  | Will not apply as things stand; a shipped repair may change that | Row in `pending_events`, `status = 'unusable'` |

Every event in the request appears exactly once in `dispositions`, identified by its `index` in the
request. `clientEventId` is echoed when the event carried a readable one and is `null` otherwise.

### Reason codes

| Code                    | Status     | Leaves pending when                                               |
| ----------------------- | ---------- | ----------------------------------------------------------------- |
| `card-not-emitted`      | `pending`  | The config emits the card again (FR-007)                          |
| `not-enrolled`          | `pending`  | The account enrols in the material (FR-018)                       |
| `awaiting-confirmation` | `pending`  | The learner answers the merge question (FR-011)                   |
| `repaired`              | `pending`  | The config emits the card of the event a repair produced (FR-019) |
| `card-unknown`          | `unusable` | A repair makes it an id some config emits (research D8, D9)       |
| `malformed`             | `unusable` | A repair makes it a well-formed event (research D9)               |

`reason` is human-readable detail for operators. Clients MUST NOT parse it.

### Client obligation

On any `200`, the client deletes **every event the request carried**, whatever the dispositions say
(FR-005). Dispositions are information for logging and display. This is what lets an event whose
`clientEventId` the server could not read still leave the outbox, and it means a client that does
not recognise a future disposition or reason code needs no special handling.

On `needsConfirm: true` the client still deletes. The question is now the server's to hold; the
client learns of it from `GET /state` and answers through `POST .../confirm`.

### Status codes

| Code | When                                                                                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 200  | Every request carrying a readable list of events, including one where nothing applied, one for a material the account is not enrolled in, and one held for confirmation |
| 400  | The body is not a JSON object with an `events` array. Carries no events, so strands none                                                                                |
| 401  | Not authenticated                                                                                                                                                       |
| 409  | An event's `snapshotVersion` is behind; client refetches `/state` and re-stamps                                                                                         |
| 413  | More than 500 events in one request                                                                                                                                     |

**Gone**:

* The 400 for unknown card ids. An id the engine cannot resolve is a disposition, not a refusal.
* The 400s for malformed fields. A malformed event is taken as `unusable` with reason `malformed`,
  because a client that cannot hand over its junk cannot empty its outbox (SC-002).
* The 404 for "not enrolled". Those events are taken as `pending` with reason `not-enrolled`.

Why the remaining refusals strand nothing is in the spec, under "What Refusal Still Means".

## `GET /api/sync/:materialId/state`

Adds one field, `null` when there is nothing to ask:

```json
{
  "pendingConfirmation": {
    "queuedCount": 57,
    "serverEventsSince": 212,
    "oldestQueuedTs": 1788991284,
    "newestServerTs": 1790091633
  }
}
```

It summarises every `awaiting-confirmation` row for this account and material. Because it is read
from the server, any device can raise the question, including one wiped after the upload.

The existing `404` for a material the account is not enrolled in stays: that is a read of state that
does not exist, not a refusal to take work.

## `POST /api/sync/:materialId/confirm` (new)

```json
{ "decision": "merge" }
```

`decision` is `merge` or `discard`.

* **merge**: every `awaiting-confirmation` row for this account and material is applied at its
  recorded time (FR-016), which rebuilds the engine because the rows predate history already
  applied. Responds with the same body as an upload, dispositions omitted.
* **discard**: every such row becomes `status = 'discarded'`. Nothing is deleted. Responds
  `{ "discarded": 57 }`.

Either answer with no open question is a no-op that returns `200` with zero counts, so a question
answered on another device first is not an error.

| Code | When                           |
| ---- | ------------------------------ |
| 200  | Answered, or nothing to answer |
| 400  | `decision` is neither value    |
| 401  | Not authenticated              |
| 404  | Not enrolled in this material  |

## Compatibility

`deploy-web.yml` and `deploy-api.yml` fire on the same master push with no ordering between them, so
each side must work against the other's previous release.

**Old client, new server.** An old client already deletes every event it sent on a `200`, so the new
delete rule is what it does today. It ignores `dispositions`. On `needsConfirm: true` it keeps its
outbox and shows the modal, as before:

* **Sync** re-uploads with `confirmMerge: true`. The server treats a re-upload of events it holds as
  `awaiting-confirmation`, with that flag set, as a `merge` for those rows, and reports them
  `applied` rather than `duplicate`.
* **Discard** deletes locally and never tells the server. The server's copy stays
  `awaiting-confirmation`: inert, visible to an operator, and answerable from any updated client.

**New client, old server.** A new client treats the old server's separate `needsConfirm` arm, which
has no `dispositions`, as "nothing was taken" and keeps its outbox, falling back to the old
`confirmMerge` re-upload. That fallback can be removed once the server has shipped.
