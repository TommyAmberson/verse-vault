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

**Decision**: one request header carries the client's last-seen counter on every API call, and the
same header on every authenticated response carries `<userId>:<counter>`, wipes and refusals
included. Naming the account matters during a profile switch, when the session cookie has moved to
the next account before the app shows it. No response body repeats the counter.

**Rationale**: `request()` in `apps/web/src/api.ts` is the single place every call goes through, so
sending is one line, and reading it back from any response covers "at launch" and "with each sync"
(FR-005) without a new endpoint. Body fields would touch every progress payload and the sync format.

**Alternatives considered**: a field in each progress body (more shapes to change, and the client
still needs a way to learn the counter); a dedicated endpoint polled at launch (an extra request).

## D3. When a write is refused

**Decision**: the three progress routes (`POST /api/sync/:materialId/events`,
`POST /api/cards/review`, `POST /api/cards/memorize/graduate` and `/graduate-card`) compare the sent
counter with the current one right before each hold, with no await between check and write, and
again inside `withLock` immediately before writing. A mismatch returns 409 with a stable code, the
current counter in the response header, and stores nothing.

**Rationale**: the check inside the lock catches a write that loaded its deck before the wipe
(FR-003). The early check keeps the sync route from parking a stale batch as held events in the
paths that hold before taking the lock.

**Alternatives considered**: checking only in middleware (misses the write that waits on the lock
across a wipe).

## D4. Moving the counter during a wipe

**Decision**: a wipe increments the counter first, before its per-deck passes, but responses keep
announcing the old value until the wipe has finished (an in-process record of running wipes; the API
is one process, as its per-deck locks already assume).

**Rationale**: every write that takes a deck's lock after the wipe starts then sees the new value,
including writes queued behind the wipe's own lock. Incrementing at the end would leave the gap spec
006 recorded. Announcing late means a client catches up only once nothing more will be cleared, so
what it writes afterwards can't be deleted by a pass still to come.

## D5. Catching up on the client

**Decision**: the client keeps the counter on its profile row, and a response counts only when the
account it names is the active profile. A newer counter starts a catch-up, one at a time, which
first re-reads the stored counter, since another tab may have caught up already. Otherwise it clears
the profile's local data, stores the counter with a notice flag on the profile row, and reloads the
page, so no view keeps running on cleared data and the notice shows from the row until dismissed.
Until the clear has finished, the old outbox still goes up with the old counter and is refused,
never accepted; if the clear fails, the counter stays old and the next response tries again. A first
counter is adopted without clearing (spec edge case "A device that first hears of the counter after
a wipe"). A lower counter than the stored one means the server went back (a restore), so it is
adopted without clearing rather than leaving the device refused for good. A reset refusal is not
treated as a snapshot mismatch: its events are not re-stamped and resent. The device that runs a
wipe holds back the counter its own responses bring, clears its local data, and then stores it with
no notice (spec US2 scenario 3), even when the wipe request fails after the counter moved; if it
heard nothing back, the catch-up that follows shows no notice either; if its clear fails, the next
launch catches up instead. A tab that finds the stored counter already current (another tab caught
up) reloads onto what that tab left.

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
