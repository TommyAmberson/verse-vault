# Data Model: Reset Counter

## Reset counter (server)

| Field     | Type    | Rules                                                     |
| --------- | ------- | --------------------------------------------------------- |
| `userId`  | text    | primary key, references `user.id`, cascade on delete      |
| `counter` | integer | not null, starts at 0 (no row reads as 0), only increases |

State: a wipe (Delete all progress or Reset account) increments it by one, before clearing anything.
Nothing else changes it; import does not.

## Last-seen counter (web client)

A field on each profile row in the IndexedDB profile registry.

| Field        | Type              | Rules                                                                               |
| ------------ | ----------------- | ----------------------------------------------------------------------------------- |
| `resetEpoch` | number, or absent | absent until the first response that carries a counter; then the highest value seen |

Transitions:

* absent → n: adopt without clearing local data.
* m → n, n > m, learned from a response or a refusal: clear the profile's local data, store n, show
  the notice once.
* m → n while this profile's own wipe is in progress (from the wipe response or its header): store
  n, clear local data, no notice.
