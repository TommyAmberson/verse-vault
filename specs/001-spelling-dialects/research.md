# Phase 0 Research: Spelling Dialects

Three questions had to be settled before design. None were marked `NEEDS CLARIFICATION` in the spec
— they are implementation choices the spec deliberately left open.

## R1 — Where substitution runs

**Decision**: Move substitution to the client. The server serves the published text; the reader's
browser applies their dialect at display time.

**Rationale**: Three independent arguments converge.

_The cache forces it._ Rendered verse HTML is cached in two places, neither keyed on the reader:
`PASSAGES_CACHE` in `routes/materials.ts` holds one entry per `materialId`, and the IndexedDB
`renders` store holds one per card. A per-reader dialect applied server-side would either serve one
reader another's spelling from cache, or require the dialect in every cache key, tripling entries
for a preference that changes nothing about the underlying scripture. Client-side substitution keeps
one cached artifact per card and applies the reader's dialect after the cache, where it belongs.

_It makes FR-013 structural._ The displayed text and the recitation diff's canonical side both live
in the client. Substituting there means both derive from one dialect application, so "a reader who
types what they were shown is never marked wrong" holds by construction rather than by two
subsystems happening to agree.

_It is the better licensing posture._ The server never emits, caches, or transmits altered
scripture. What crosses the wire is the publisher's text under the publisher's attribution; the
modification is something the reader's own browser does to their own view, disclosed on screen. That
is a materially easier position to explain than a server that stores and serves a modified
translation, and it costs nothing extra given the other two arguments.

**Alternatives considered**:

* _Keep it server-side, add dialect to cache keys._ Rejected: triples cache entries, keeps altered
  text in server caches and on the wire, and leaves FR-013 dependent on the client's expected-text
  source matching what the server substituted.
* _Server-side with per-user render cache._ Rejected: worse than the above on every axis, and it
  turns a shared cache into per-user storage of api.bible-derived content, which brushes against the
  no-bulk-extraction constraint in `NOTICE.md`.
* _Substitute in the WASM engine._ Rejected on Constitution II — the core is memory modelling, not
  presentation — and it would put a 125 KB dictionary into the WASM boundary for no benefit.

## R2 — Dictionary delivery to the browser

**Decision**: Derive the dictionaries at build time, ship them as separate lazily-fetched assets,
and load only the one the reader selected.

**Rationale**: Measured sizes, uncompressed:

| Dialect        | Entries | Size        |
| -------------- | ------- | ----------- |
| British (`B`)  | 15,747  | 451.2 KB    |
| Canadian (`C`) | 4,864   | 125.3 KB    |
| American       | —       | none needed |

Neither belongs in the initial bundle, and `varcon`'s raw `A.json` (640 KB, 16,490 entries) belongs
there even less — the derivation drops multi-word entries and entries whose variant equals the
American form, which is most of them for Canadian. Building the derived maps at build time rather
than at module load also removes the startup cost the server currently pays on every boot.

The default dialect needs no dictionary at all, which means the out-of-the-box reader downloads
nothing extra — a pleasant consequence of FR-009.

**Alternatives considered**:

* _Ship both dictionaries in the main bundle._ Rejected: 576 KB for a preference most readers will
  not change.
* _Fetch substitutions from the server per verse._ Rejected: reintroduces the server-serves-altered
  text problem R1 exists to remove, and adds a round-trip to rendering.
* _Derive at runtime from `A.json` in the browser._ Rejected: ships the largest artifact to do work
  that is identical for every reader.

## R3 — Where the per-reader preference lives

**Decision**: A new `user_preferences` table keyed on `user_id` alone.

**Rationale**: Dialect is a property of the reader, not of the reader-material pair. The obvious
existing home, `user_year_settings`, is keyed `(user_id, material_id)` and holds per-deck scope
toggles. Putting dialect there would mean a reader could have Canadian spelling in one deck and
American in another, which nobody wants and which FR-007 forbids — the same word must not appear in
two spellings across the product.

A dedicated per-user table also gives later reader-level preferences somewhere obvious to go, and
avoids widening a table that a pending migration is already scheduled to narrow (the legacy flat
columns `user_year_settings` still carries alongside `config_json`).

**Alternatives considered**:

* _A column on Better Auth's `user` table._ Rejected: that table is owned by the auth library and
  its migrations; adding product columns invites conflicts on upgrade.
* _Reuse `user_year_settings`._ Rejected as above — wrong key, and it would let FR-007 be violated.
* _Client-only, in `localStorage`._ Tempting given substitution moves client-side, and genuinely
  simpler. Rejected because the product is multi-device (browser plus Tauri desktop) and a reader
  who sets Canadian on their laptop should not meet American on the desktop app. Worth revisiting if
  the licensing answer pushes toward keeping the server maximally uninvolved.

## Open, carried forward from the spec

Whether the licence permits the alteration at all. Not a research question — it is answered by the
API.Bible account agreement and the publisher's permissions department, not by investigation inside
the repository. Tranche B is gated on it. See the Licensing Constraints section of `spec.md`.
