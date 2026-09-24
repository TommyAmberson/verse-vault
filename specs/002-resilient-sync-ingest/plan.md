# Implementation Plan: The Server Takes Every Event

**Branch**: `fix/sync-takes-every-event` | **Date**: 2026-09-23 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-resilient-sync-ingest/spec.md`

## Summary

Upload becomes total. `POST /api/sync/:materialId/events` stops refusing events: every event is
taken and given one of four dispositions (`applied`, `duplicate`, `pending`, `unusable`), reported
per event by position. Events that cannot be applied rest in a new server-side `pending_events`
table with a reason code, and are reconsidered at engine build, so a setting toggled back on or a
late enrolment brings its work with it, at the time it was recorded. The stale-merge question moves
to the server: a stale batch is taken as pending, `GET /state` reports the open question, and a new
`POST .../confirm` answers it. Telling "not emitted today" from "never emittable" is the engine's
call, so core gains the config that emits every card any config can, and the api checks ids against
an engine built with it. Unusable events stay retryable: repairs shipped in the api are tried on
them at engine build, and one that makes an event applicable sends it through promotion. Replay
stops throwing on rows it cannot resolve. The client uploads in chunks, deletes everything an
acknowledged upload carried, and loses its orphan store and its stale gate.

## Technical Context

**Language/Version**: TypeScript on Node `^20.19.0 || >=22.12.0` (api, web); Rust 1.75+ compiled to
WASM for the engine

**Primary Dependencies**: Hono, Drizzle, better-sqlite3, Better Auth (api); Vue 3 + Vite, IndexedDB
(web); `verse-vault-wasm` for both

**Storage**: SQLite at `/var/lib/verse-vault/verse-vault.db`; Drizzle migrations in
`packages/api/migrations/`; IndexedDB per profile on the client

**Testing**: vitest (api, web), `cargo test` (core/wasm), including a property test that every card
any config emits is also emitted under the maximal config. No `crates/sim` run required: no
scheduling or memory-model behaviour changes.

**Target Platform**: Node process on a DigitalOcean VPS behind Cloudflare; evergreen browsers

**Project Type**: Web application, pnpm workspace plus Rust workspace

**Performance Goals**: No regression on the sync path. The pending-events lookup on engine build
must be a single indexed count when there is nothing pending, which is the overwhelmingly common
case. The maximal-config engine is built only when an upload carries an id the current engine lacks,
and its id set is cached per material and snapshot version.

**Constraints**: Uploads capped at 500 events per request server-side. The client must drain
regardless of outbox size. Migration must be safe on a live database with existing rows.

**Scale/Scope**: 5 accounts, low thousands of events per account, single-digit materials. Scope is
correctness and recoverability, not throughput.

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

| Principle                           | Assessment                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Design Docs Are Source of Truth  | `docs/server-api.md` currently documents whole-batch refusal, and `docs/persistence.md` describes only `review_events` plus materialised state. Both MUST change in this PR (FR-015). The deviation note added earlier is removed rather than amended.                                                                                                        |
| II. Pure Core, Thin Edges           | No algorithm change. Tolerating an unreplayable row is error handling at the consumer, and `replay_event` already returns `Result`. Classifying an unknown card id needs to know which config flags gate emission, which is builder knowledge, so core owns it (`MaterialConfig::max_emission`, research D8) rather than the api hard-coding a list of gates. |
| III. Contract Versions Are Promises | `crates/core` and `crates/wasm` both change: an additive constructor and one wasm export. MINOR bump for each (0.9.0 to 0.10.0) with dated CHANGELOG entries in the same commit. Replay and the wire shape are unchanged, so not MAJOR.                                                                                                                       |
| IV. Validate Before You Ship        | Tests precede each behaviour change. Sim not applicable. The flush path has no harness today (#157), and this feature adds client behaviour that must be tested, so a harness is in scope rather than deferred.                                                                                                                                               |
| V. Atomic, Traceable History        | One logical change per commit, in the dependency order in Phase 2. Feature branch, merge commit, no squash.                                                                                                                                                                                                                                                   |
| VI. No Client Can Get Stuck         | This feature exists to satisfy it. The gate is SC-001, and it is the quickstart's first scenario.                                                                                                                                                                                                                                                             |

**Result**: PASS. No violations to justify; Complexity Tracking omitted.

**Re-check after revision (2026-09-23)**: PASS. The revised spec moved the stale-merge question to
the server (research D6) and needs ids classified by the engine (D8). D6 strengthens VI, since the
old preflight held work in the browser while it waited. D8 adds contract crate changes, handled
under II and III above. No new package, crate, or exception.

## Project Structure

### Documentation (this feature)

```text
specs/002-resilient-sync-ingest/
├── spec.md              # Approved 2026-09-24
├── plan.md              # This file
├── research.md          # Phase 0 decisions
├── data-model.md        # Phase 1 entities
├── contracts/
│   └── sync-events.md   # Upload request/response contract
├── quickstart.md        # Phase 1 validation guide
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
crates/
├── core/src/material_config.rs        # MaterialConfig::max_emission, superset test
└── wasm/src/lib.rs                    # max_emission_config_json export

packages/api/
├── migrations/
│   └── 0028_pending_events.sql        # new table
├── src/
│   ├── db/schema.ts                   # pendingEvents table
│   ├── lib/
│   │   ├── engine.ts                  # total replay; promote pending on build; max-emission id set
│   │   ├── pending-events.ts          # take / promote / count helpers
│   │   ├── repairs.ts                 # shipped repairs for unusable events
│   │   └── sync-events.ts             # upload parsing, shared by the route and repairs
│   └── routes/
│       └── sync.ts                    # dispositions; refusals removed; state + confirm routes

apps/web/src/
├── api.ts                             # dispositions; confirm call
├── composables/useEngine.ts           # modal driven by pendingConfirmation; orphanCount gone
├── components/StaleMergeModal.vue     # copy: discard no longer deletes anything
└── lib/engine/
    ├── engineStore.ts                 # chunked flush; delete all sent; stale gate removed
    ├── persistence.ts                 # IDB v2: drain and drop orphan store
    └── types.ts                       # SyncEventsResponse, state response

docs/
├── server-api.md                      # rewritten sync contract (FR-015)
└── persistence.md                     # pending_events in the storage model
```

**Structure Decision**: Existing web-application layout. No new package or crate. The only new
module is `packages/api/src/lib/pending-events.ts`, which keeps the take/promote logic out of the
route handler so both the route and the engine-build path can call it. The contract crates gain one
constructor and one export, nothing structural.

## Phase 2 Preview (ordering, not tasks)

`/speckit-tasks` will expand these. The dependency order matters:

1. Total replay (#152). Prerequisite: it is the only reason ingest had to refuse anything.
2. `MaterialConfig::max_emission` in core and its wasm export, with the contract bumps, then the
   api's cached max-emission id set. The route cannot classify ids without it.
3. `pending_events` table and helpers, with tests, before any route change.
4. Route: dispositions for every event; remove the 400 and 404 refusals.
5. Promotion at engine build at the recorded time, with the cheap no-op guard.
6. Repairs tried on unusable rows at engine build, before promotion (research D9).
7. Stale-merge question on the server: take as `awaiting-confirmation`, report on `GET /state`,
   answer through `POST .../confirm`, and honour an old client's `confirmMerge` re-upload.
8. Client: chunked flush, delete everything sent, stale gate replaced by `pendingConfirmation`, IDB
   v2 draining the orphan store.
9. Docs rewrite and changelog entries.

Steps 1 to 7 are shippable without step 8: an older client keeps working, because it already deletes
what it sent on a `200` and still handles `needsConfirm` as before (see contracts). That matters,
since web and api deploy with no ordering guarantee.
