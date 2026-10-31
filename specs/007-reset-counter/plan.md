# Implementation Plan: Reset Counter

**Branch**: `feat/reset-epoch` | **Date**: 2026-10-30 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/007-reset-counter/spec.md`

## Summary

Every account gets a reset counter that Delete all progress and Reset account move on before they
clear anything. The web client sends the counter it last saw on every API request, and every
authenticated response says what the current one is. The three progress writes (sync uploads, single
reviews, memorize graduations) refuse a stale counter, checking again under the deck's lock right
before writing. A client that sees a newer counter clears its local data for that account, adopts
the counter, and shows one notice unless it ran the wipe itself. Requests without a counter are
accepted for this release (see [research.md](research.md) for each decision).

## Technical Context

**Language/Version**: TypeScript 5 (Node 24 API, Vue 3 web)

**Primary Dependencies**: Hono, Drizzle ORM + better-sqlite3, Better Auth 1.6, Vue 3, IndexedDB

**Storage**: SQLite (one new table, one migration); per-profile registry in IndexedDB on the web

**Testing**: vitest in `packages/api` and `apps/web`; `vue-tsc` and `vite build` for the web

**Target Platform**: Linux server; browsers (the Tauri shell reuses the web bundle)

**Project Type**: web service + web client

**Performance Goals**: one extra primary-key read per progress write; no extra request on any path

**Constraints**: older clients keep syncing for one release; no change to `crates/core` or
`crates/wasm`

**Scale/Scope**: a handful of routes in `packages/api`, the request helper and local-reset path in
`apps/web`

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

| Principle                | Status | Notes                                                                                                                                                                                                                                                        |
| ------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| I. Design docs           | Pass   | `docs/server-api.md` gains the counter header, the refusal, and the wipe response; `docs/web-nav.md` the notice. Spec 006's known-limitation edge case points here (FR-010).                                                                                 |
| II. Pure core            | Pass   | No engine change. The check sits in the API routes and the web request helper.                                                                                                                                                                               |
| III. Contract versions   | Pass   | core and wasm untouched; api and web bump.                                                                                                                                                                                                                   |
| IV. Validate before ship | Pass   | Route tests for refusal (including a write queued behind a wipe), web tests for catch-up; no scheduling change, so no sim run.                                                                                                                               |
| V. Atomic history        | Pass   | Commits per layer: schema + wipe, route checks, web, docs, releases.                                                                                                                                                                                         |
| VI. No client stuck      | Pass   | Refused pre-wipe records fall under VI's wipe exception (constitution 1.5.0): only the reset counter identifies them, and the client tells the learner (FR-007). The refusal carries the current counter, so catching up needs only what the server returns. |
| VII. Simplest design     | Pass   | One header both ways instead of a field in each body; reuse `resetProfileLocalData` and the existing wipe routes.                                                                                                                                            |

## Project Structure

### Documentation (this feature)

```text
specs/007-reset-counter/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/server-api.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
packages/api/src/
├── db/schema.ts            # new reset-counter table
├── db/migrations/          # one migration
├── lib/reset.ts            # wipeAccount moves the counter on first
├── lib/                    # new: read/compare the counter (one owner)
├── routes/account.ts       # wipe responses carry the new counter
├── routes/sync.ts          # POST events: refuse stale, before and under the lock
├── routes/cards.ts         # review, graduate, graduate-card: same
└── (app setup)             # middleware: response header on authenticated requests
apps/web/src/
├── api.ts                  # request(): send the counter, read it back, handle refusal
├── composables/useAuth.ts  # per-profile counter, catch-up via resetProfileLocalData
└── views/                  # notice after catching up
```

**Structure Decision**: existing `packages/api` and `apps/web` layout; no new package.

## Reuse and Ownership

| Decision or write path                         | Owner                                                                                    | Existing code reused                                |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------- |
| An account's current counter, and moving it on | new: one module in `packages/api/src/lib/` that reads, compares, and increments it       | `wipeAccount` in `lib/reset.ts` calls it            |
| Whether a progress write is refused            | the same module's comparison, called by each progress route before and inside `withLock` | `EngineStore.withLock`                              |
| Telling the client the current counter         | one Hono middleware on the authenticated API                                             | the existing auth middleware that resolves the user |
| Client's last-seen counter                     | the profile registry row in `useAuth.ts`                                                 | `registry.upsertProfile`                            |
| Sending and reading the counter                | `request()` in `apps/web/src/api.ts`                                                     | its existing header and error handling              |
| Clearing local data on catch-up                | `resetProfileLocalData` in `useAuth.ts`                                                  | as is                                               |

**Platform already provides**: Better Auth owns the `user` table, so the counter lives in a table of
our own rather than an additional user field. `withLock` already serialises writes per deck.

**Releases**: api MINOR (new header and refusal), web MINOR (catch-up and notice). core and wasm
unchanged. A later api release removes the allowance for requests without a counter (FR-008).
