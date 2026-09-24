# Test scenarios

Reference checklist for sync-protocol + offline-mode behaviours that aren't covered (or aren't fully
covered) by automated tests. Most are manual browser smokes that need DevTools + IDB inspector;
where a unit test exists already it's linked so the manual run is a sanity check, not the primary
signal.

The automated suite lives in `packages/api/src/routes/*.test.ts` (vitest),
`apps/web/src/**/*.test.ts` (vitest), and `cargo test`. Client-side coverage reaches the flush path
and IndexedDB layer through `apps/web/src/lib/engine/testing/harness.ts`, but not the views or the
offline-render paths, so anything in the "manual smoke" column remains the authoritative test for
that behaviour.

## Sync protocol

| Scenario                                                 | Automated                                                             | Manual smoke                                                                                                            |
| -------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Snapshot-version 409                                     | [sync.test.ts](../packages/api/src/routes/sync.test.ts)               | —                                                                                                                       |
| Online device wiped without loss (SC-001)                | —                                                                     | Sync, DevTools → Application → Clear site data, reload, sign in: history, memorised verses and due counts unchanged     |
| Open merge question survives a wipe                      | [sync.test.ts](../packages/api/src/routes/sync.test.ts)               | Trigger the modal (below), clear site data without answering, reload: the modal returns, raised from the server         |
| Good events land beside unusable ones                    | [sync.test.ts](../packages/api/src/routes/sync.test.ts)               | Put a `graduateCard` with `cardId: 7578` into IDB `eventQueue` beside real reviews; flush: reviews land, outbox empties |
| Malformed and far-future events taken as unusable        | [sync.test.ts](../packages/api/src/routes/sync.test.ts)               | —                                                                                                                       |
| Switched-off card waits, then applies when switched back | [engine.test.ts](../packages/api/src/lib/engine.test.ts)              | Offline, memorise a verse with FTV; turn FTV off; sync; turn FTV on: the graduation applies                             |
| Outbox past 500 events drains in pages                   | [engineStore.test.ts](../apps/web/src/lib/engine/engineStore.test.ts) | —                                                                                                                       |
| Out-of-order rebuild (older event arrives after newer)   | [sync.test.ts](../packages/api/src/routes/sync.test.ts)               | Seed via DevTools across two profiles                                                                                   |
| In-order no-rebuild                                      | [sync.test.ts](../packages/api/src/routes/sync.test.ts)               | —                                                                                                                       |
| Stale batch held on the server and the learner asked     | [sync.test.ts](../packages/api/src/routes/sync.test.ts)               | Edit IDB `eventQueue` row's `timestampSecs` 6 months back; reload                                                       |
| Merge / Discard answer through `POST .../confirm`        | [sync.test.ts](../packages/api/src/routes/sync.test.ts)               | Click Sync or Discard in the modal after the above; Discard leaves `status = 'discarded'` rows                          |
| Stale-merge below threshold (no prompt)                  | [sync.test.ts](../packages/api/src/routes/sync.test.ts)               | —                                                                                                                       |
| Cancel hides the question until the next boot            | —                                                                     | After the modal appears, click Cancel; reload: the modal returns                                                        |
| Mixed review + graduate batch                            | [sync.test.ts](../packages/api/src/routes/sync.test.ts)               | —                                                                                                                       |
| Graduate event writes `graduatedVerses`                  | [sync.test.ts](../packages/api/src/routes/sync.test.ts)               | —                                                                                                                       |

Stranded work is answerable from the server alone. Anything taken but not applied is in
`pending_events` (see [`persistence.md`](persistence.md)):

```bash
ssh verse-vault@<vps> "sqlite3 -readonly /var/lib/verse-vault/verse-vault.db \
  'SELECT user_id, material_id, status, reason_code, count(*) FROM pending_events GROUP BY 1,2,3,4;'"
```

An empty result means nothing is stranded. Each sync request that stores anything also logs a
`sync.events_not_applied` line with its requestId.

## Offline-mode (lazy + opt-in renders cache)

| Scenario                                                              | Automated                                                                        | Manual smoke                                                                                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Lazy cache: viewing one card stores only that card                    | —                                                                                | Review one card online; DevTools → IndexedDB → `verse-vault` → `renders` has 1 entry for that material           |
| Render staleness: 30d TTL on read                                     | —                                                                                | Set a row's `fetchedAt` to 31d ago in DevTools; reload — UI refreshes single-card or shows offline affordance    |
| Snapshot-version bump invalidates renders                             | —                                                                                | Bump `materialData.version` in dev; verify `clearRenders(materialId)` runs on next `/state` fetch                |
| GET /renders gated on offline_mode                                    | [materials.test.ts](../packages/api/src/routes/materials.test.ts) (403 when off) | —                                                                                                                |
| Bulk download seeds IDB with every card                               | [materials.test.ts](../packages/api/src/routes/materials.test.ts) (server side)  | Toggle on in MaterialView; verify IDB `renders` count == card count                                              |
| Toggle off clears IDB entries                                         | —                                                                                | Toggle off; verify `renders` store is empty for that material                                                    |
| "Refreshed N days ago" indicator                                      | —                                                                                | Verify label appears after first download; matches days since newest `fetchedAt`                                 |
| Offline mutation: review N cards offline, graduate 1, restore network | —                                                                                | DevTools → Network → Offline; grade 10 + graduate 1; restore → verify 11 events flush + server matches           |
| Compression on bulk path                                              | —                                                                                | `curl -H 'Accept-Encoding: gzip' /api/materials/nkjv-cor/renders` → `Content-Encoding: gzip`; ~1 MB vs ~5 MB raw |

## Attribution + MAUA compliance

| Scenario                                  | Manual smoke                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Footer attribution visible on every route | Navigate to /, /review, /memorize, /material, /stats — NKJV citation + api.bible link present in footer                  |
| 30-day TTL prune-on-load                  | Restart API with `apibible_passages` rows older than 30d — verify they're deleted on boot                                |
| No bulk extraction without consent        | `GET /sync/state` response body contains no `renders` field; `GET /materials/:id/renders` returns 403 without the toggle |
