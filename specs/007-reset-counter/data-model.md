# Data Model: Reset Counter

## Reset counter (server)

| Field     | Type    | Rules                                                     |
| --------- | ------- | --------------------------------------------------------- |
| `userId`  | text    | primary key, references `user.id`, cascade on delete      |
| `counter` | integer | not null, starts at 0 (no row reads as 0), only increases |

State: a wipe (Delete all progress or Reset account) increments it by one, before clearing anything.
Nothing else changes it; import does not.

## Last-seen counter (web client)

Fields on each profile row in the IndexedDB profile registry.

| Field                | Type               | Rules                                                                               |
| -------------------- | ------------------ | ----------------------------------------------------------------------------------- |
| `resetEpoch`         | number, or absent  | absent until the first response that carries a counter; then the highest value seen |
| `resetNoticePending` | boolean, or absent | true from a catch-up until the learner dismisses the notice                         |

Transitions, for a response naming the active profile's account (others change nothing), checked
against the row as stored, not as held in memory:

* absent → n: adopt without clearing local data (see spec edge case "A device that first hears of
  the counter after a wipe").
* m → n > m: clear local data, then store n with the notice flag, and reload. If the clear fails, m
  stays and the next response tries again.
* m → n < m, from a request sent with m: the server went back (a restore); adopt n without clearing,
  so this device's data can go up again. From a request sent with anything else (a slow response
  from before this device's own wipe), ignore it.
* m → n while this profile's own wipe is in progress: clear local data, then store n, no notice,
  even if the wipe request then failed.
