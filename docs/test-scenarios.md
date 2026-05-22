# Test scenarios

Reference checklist for sync-protocol + offline-mode behaviours that aren't covered (or aren't fully
covered) by automated tests. Most are manual browser smokes that need DevTools + IDB inspector;
where a unit test exists already it's linked so the manual run is a sanity check, not the primary
signal.

The automated suite lives in `packages/api/src/routes/*.test.ts` (vitest) and `cargo test`. As of
this writing apps/web has no client-side tests — anything in the "manual smoke" column below is the
authoritative test for that behaviour until that infrastructure lands.

## Sync protocol

| Scenario                                                  | Automated                                                   | Manual smoke                                                                                   |
| --------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Snapshot-version 409                                      | [sync.test.ts:249](../packages/api/src/routes/sync.test.ts) | —                                                                                              |
| Clock-skew rejection (events > now+24h)                   | [sync.test.ts:262](../packages/api/src/routes/sync.test.ts) | —                                                                                              |
| Out-of-order rebuild (older event arrives after newer)    | [sync.test.ts:320](../packages/api/src/routes/sync.test.ts) | Seed via DevTools across two profiles                                                          |
| In-order no-rebuild                                       | [sync.test.ts:356](../packages/api/src/routes/sync.test.ts) | —                                                                                              |
| Stale-merge preflight above threshold                     | [sync.test.ts:374](../packages/api/src/routes/sync.test.ts) | Edit IDB `eventQueue` row's `timestampSecs` 6 months back; reload                              |
| Stale-merge bypass with `confirmMerge: true`              | [sync.test.ts:416](../packages/api/src/routes/sync.test.ts) | Click Sync in the modal after the above                                                        |
| Stale-merge below threshold (no prompt)                   | [sync.test.ts:446](../packages/api/src/routes/sync.test.ts) | —                                                                                              |
| Cancel button clears `staleGate` so next flush re-prompts | —                                                           | After modal appears, click Cancel; click Save in MaterialView; verify modal re-opens within 5s |
| Mixed review + graduate batch                             | [sync.test.ts:474](../packages/api/src/routes/sync.test.ts) | —                                                                                              |
| Graduate event writes `graduatedVerses`                   | [sync.test.ts:276](../packages/api/src/routes/sync.test.ts) | —                                                                                              |

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
