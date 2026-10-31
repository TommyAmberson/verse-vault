# Research: Reset Counter

## D1. Where the counter lives

**Decision**: a table of our own keyed by user id, holding one integer. No row means 0.

**Rationale**: Better Auth owns `user`; adding a field there means declaring it in the auth config
and exposing it through Better Auth's types. A small table is migrated and read like any other.
Deleting the user cascades.

**Alternatives considered**: a Better Auth additional field (couples the counter to the auth
library); a per-deck counter (the spec's assumption: every write already names its account, and a
wipe covers every deck).

## D2. How the counter travels

**Decision**: one request header carries the client's last-seen counter on every API call, and one
response header carries the current counter on every authenticated response. Wipe responses also put
the new counter in the body.

**Rationale**: `request()` in `apps/web/src/api.ts` is the single place every call goes through, so
sending is one line, and reading it back from any response covers "at launch" and "with each sync"
(FR-005) without a new endpoint. Body fields would touch every progress payload and the sync format.

**Alternatives considered**: a field in each progress body (more shapes to change, and the client
still needs a way to learn the counter); a dedicated endpoint polled at launch (an extra request).

## D3. When a write is refused

**Decision**: the three progress routes (`POST /api/sync/:materialId/events`,
`POST /api/cards/review`, `POST /api/cards/memorize/graduate` and `/graduate-card`) compare the sent
counter with the current one at the top of the handler, before any hold is written, and again inside
`withLock` immediately before writing. A mismatch returns 409 with a stable code and the current
counter, and stores nothing.

**Rationale**: the check inside the lock catches a write that loaded its deck before the wipe
(FR-003). The early check keeps the sync route from parking a stale batch as held events in the
paths that hold before taking the lock.

**Alternatives considered**: checking only in middleware (misses the write that waits on the lock
across a wipe).

## D4. Moving the counter during a wipe

**Decision**: `wipeAccount` increments the counter first, before its per-deck passes.

**Rationale**: every write that takes a deck's lock after the wipe starts then sees the new value,
including writes queued behind the wipe's own lock. Incrementing at the end would leave the gap spec
006 recorded.

## D5. Catching up on the client

**Decision**: the client keeps the counter on its profile row. When a response carries a counter
higher than the stored one, or a request is refused with one, the client runs
`resetProfileLocalData`, stores the new counter, and shows a one-time notice. The device that runs a
wipe marks it in progress for the profile before sending it; while the mark is set, a newer counter
(the wipe response's own header included) is adopted without the notice, and the mark clears once
the wipe's local reset finishes. Its own late refusals then match the stored counter and stay quiet
(spec US2 scenario 3). Catch-up sends a running review or memorize session back to Home, where the
app shell shows the notice (spec edge case "Wipe while a device is mid-session").

**Rationale**: reuses the local reset that the wipe already runs. A profile with no stored counter
(first launch after this release) adopts the server's value without clearing (spec edge case "A new
account or one never wiped").

## D6. Requests without a counter

**Decision**: accepted unchecked in this release. The removal is tracked as an issue and a TODO at
the comparison, for the next api release.

**Rationale**: FR-008; older web bundles cached in a browser keep syncing until they reload.

## D7. Import

**Decision**: import neither checks nor moves the counter (spec clarification): it merges, so other
devices' data stays valid.
