# Data Model: The Server Takes Every Event

**Date**: 2026-09-23 | **Plan**: [plan.md](./plan.md)

## New: `pending_events`

Holds events the server has taken but not applied. One row per taken-but-unapplied event.

| Field                   | Type                               | Notes                                                                       |
| ----------------------- | ---------------------------------- | --------------------------------------------------------------------------- |
| `id`                    | text, PK                           | Server-generated                                                            |
| `user_id`               | text, FK to `user`, cascade delete | Same ownership rule as `review_events`                                      |
| `material_id`           | text                               | Not a foreign key: a `not-enrolled` row may name a material with no row     |
| `client_event_id`       | text, nullable                     | The client's idempotency key, verbatim. `NULL` when the event had none      |
| `kind`                  | text, nullable                     | `review`, `graduate`, or `graduateCard`. `NULL` when malformed              |
| `timestamp_secs`        | integer, nullable                  | When the event happened, per the client. `NULL` when malformed              |
| `payload_json`          | text                               | The event to apply: as uploaded, or as a repair rewrote it                  |
| `original_payload_json` | text, nullable                     | The event as uploaded, set when a repair rewrites `payload_json`            |
| `repaired_by`           | text, nullable                     | Id of the repair that rewrote the event                                     |
| `repair_epoch`          | text, nullable                     | The set of shipped repairs last tried on this row; `NULL` until first tried |
| `status`                | text                               | `pending`, `unusable`, `discarded`, or `repaired`                           |
| `reason_code`           | text                               | One of the codes in [contracts/sync-events.md](./contracts/sync-events.md)  |
| `reason`                | text                               | Human-readable detail for operators, e.g. the unresolvable card id          |
| `received_at`           | integer                            | Unix seconds, when the server took it                                       |

**Indexes**

* Unique on `(user_id, material_id, client_event_id)`, mirroring `review_events`, so a retry cannot
  create a second row for the same event (D2). SQLite treats `NULL`s as distinct, so malformed
  events without an id never collide.
* On `(user_id, material_id, status)` for the engine-build lookup, the confirmation summary, and the
  operator count.

**Lifecycle**

```text
uploaded ─► applied                       (no row; lands in review_events / graduated_*)
         ├► duplicate                     (no row; already held in one of the two tables)
         ├► pending  card-not-emitted ─┐
         ├► pending  not-enrolled ─────┼► promoted at engine build ─► row deleted, real row written
         ├► pending  awaiting-confirmation ─┬► merge   ─► promoted (same as above)
         │                                  └► discard ─► status = discarded (kept)
         └► unusable card-unknown | malformed ─┬► a repair succeeds ─► pending, then as above
                                                 │    (promoted rows are kept, status = repaired)
                                                 └► no repair succeeds ─► unchanged, epoch recorded
```

Promotion writes the real row at the event's original `timestamp_secs` (FR-016) and deletes the
pending row in the same transaction, so the pair can never both exist.

What promotion costs depends on the kind. Graduations are order-insensitive, so a promoted
graduation is written and applied as the existing graduation loop does. A promoted review changes
the FSRS path of its card from its recorded time onward, so it is written to `review_events` and the
engine is rebuilt from the log (`rebuildFromEvents`), exactly as the upload route already does for
an out-of-order batch. `load` restores materialised test states rather than replaying, so it must
hand off to a rebuild whenever it promotes a review.

Engine build first tries shipped repairs on `unusable` rows whose `repair_epoch` is not the current
set of repairs (research D9), then promotes. Promotion considers only `card-not-emitted` and
`not-enrolled` rows. A promoted row with `repaired_by` set becomes `status = 'repaired'` instead of
being deleted, keeping the record of what arrived and what changed it; its client id stays held, so
a re-upload is a duplicate. `awaiting-confirmation` rows are applicable but wait for the learner
(FR-007's exception), and are promoted only by a `merge` answer.

## Unchanged, but newly constrained

* **`review_events`** stays the source of truth and the only thing replay reads. No new columns, no
  new states. The invariant this feature adds is that a row lands here only if the engine could
  resolve it at the time.
* **`graduated_verses` / `graduated_cards`** likewise. A graduation the engine cannot resolve now
  goes to `pending_events` instead of being written here unresolvable, which is how
  `UTQxkOXd…/nkjv-john`'s orphaned `86018` came to exist.

## Removed

* **`eventQueueOrphans`** (client IndexedDB store) and its `moveToOrphans` / `getOrphans` /
  `countOrphans` accessors, plus the `orphanCount` ref in `useEngine`. An IndexedDB version bump
  drains anything present into the outbox before dropping the store (FR-014).
* **The client-side stale gate.** `engineStore`'s per-material gate existed to hold a batch on the
  device until the learner answered. The question now lives on the server, so the gate goes; the
  modal is driven by `pendingConfirmation` from `GET /state`.

## Derived values

* **Operator view (FR-010)**: count and group `pending_events` by
  `(user_id, material_id, status, reason_code)`. No new table; the query is the feature.
* **`pendingConfirmation`** on `GET /state`: count, min `timestamp_secs`, and the server-history
  comparison, over this account and material's `awaiting-confirmation` rows.
* **`stateRev`** is unaffected by pending rows. It fingerprints applied history, and pending events
  have not been applied, so a pending row must not change it. Promotion does change it, correctly,
  because an event became applied.
