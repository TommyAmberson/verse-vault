# Quickstart: Validating "The Server Takes Every Event"

**Date**: 2026-09-23 | **Plan**: [plan.md](./plan.md)

Six scenarios, in the order they are worth running. The first is the feature.

## Prerequisites

```bash
pnpm install
wasm-pack build crates/wasm --target nodejs --out-dir pkg
tools/build-wasm-web.sh
pnpm --filter @verse-vault/api dev     # terminal 1
pnpm --filter @verse-vault/web dev     # terminal 2
```

## 1. An online device can be wiped without loss (SC-001)

The whole requirement, and the one to run before claiming anything works.

1. Sign in, review several verses, memorise one, wait for sync to settle.
2. In devtools, Application → Storage → **Clear site data**.
3. Reload and sign in again.

**Expected**: identical review history, memorised verses, and due counts. Nothing lost, no warning,
no recovery step.

## 2. A pending merge question survives a wipe (SC-001, FR-011)

The case the first draft of this spec missed.

1. On a scratch account, record more than ten reviews from one device.
2. On a second browser profile, go offline, review a few cards, and set that device's clock back (or
   plant events with old `timestampSecs`) so the batch predates the first device's history.
3. Go online. The merge modal appears.
4. Without answering, clear the second profile's site data and reload.

**Expected**: the modal appears again, raised from the server. Answering **Sync** applies the
reviews at their recorded times; answering **Discard** leaves them on the server with
`status = 'discarded'`. Either way the outbox was empty from step 3 onward.

## 3. One unusable event costs only itself (SC-003)

Reproduces the original incident.

1. Queue several normal reviews offline (devtools → Network → Offline).
2. Add an event with an id from no id space, straight into the outbox:

   ```js
   const name = (await indexedDB.databases()).map(d => d.name).find(n => n?.startsWith('verse-vault-'))
   // put one { kind: 'graduateCard', cardId: 7578, ... } row into the eventQueue store
   ```

3. Go back online and let the flush run.

**Expected**: every normal review lands, the outbox empties, and the response marks the planted
event `unusable` with a reason. Before this feature, the whole batch 400s and nothing lands.

## 4. A setting toggle does not strand work (SC-005)

1. Offline, memorise a verse whose deck emits an FTV card, so a `graduateCard` is queued.
2. Still offline, turn FTV off in settings.
3. Go online, let sync settle. Confirm the outbox is empty and the event is `pending` server-side,
   reason code `card-not-emitted`.
4. Turn FTV back on.

**Expected**: after step 3 the work is on the server and the device is clean; after step 4 the
graduation is applied, and the card does not resurface as new work.

## 5. Replay survives a row it cannot apply (SC-006)

```bash
# against a scratch copy of the database, not production
sqlite3 scratch.db "INSERT INTO review_events (...) VALUES (... card_id 999999999 ...);"
```

Then force a rebuild by uploading an out-of-order event for that material.

**Expected**: the rebuild completes, the bad row is skipped, and a log line names it. Before this
feature, `replay_event` throws and the rebuild fails for good.

## 6. Stranded work is visible from the server (SC-007)

```bash
ssh verse-vault@<vps> "sqlite3 -readonly /var/lib/verse-vault/verse-vault.db \
  'SELECT user_id, material_id, status, reason_code, count(*) FROM pending_events GROUP BY 1,2,3,4;'"
```

**Expected**: one row per distinct reason code, answering in a single query what took two weeks and
a user's devtools to answer in September.

## Regression checks

```bash
cargo test && cargo clippy --all-targets
pnpm --filter @verse-vault/api test
pnpm --filter @verse-vault/web test
dprint check && tools/check-contract-versions.sh
```
