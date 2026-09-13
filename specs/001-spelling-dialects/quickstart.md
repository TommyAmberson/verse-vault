# Quickstart: Validating Spelling Dialects

How to prove the feature works. Scenarios map to spec requirements; each is runnable against a dev
stack.

## Prerequisites

```
pnpm install
wasm-pack build crates/wasm --target nodejs --out-dir pkg
pnpm dev:all
```

A signed-in reader and at least one enrolled material with cached passage text. Dialect only shows
on rendered verse HTML, so a deck whose api.bible content has never been fetched will show nothing
to substitute.

## Automated

```
pnpm test                  # api + web suites
pnpm --filter @verse-vault/api test -- spelling     # substitution rules
pnpm --filter web test -- spelling                  # client substitution + disclosure
```

The existing `packages/api/src/lib/spelling.test.ts` covers substitution behaviour and should keep
passing unchanged when the logic relocates — it tests the function, not its address. Treat a
required edit to those assertions as a signal that behaviour drifted during the move.

## Scenario 1 — Default is the published text (FR-009, SC-009)

The most important one, and the easiest to get wrong.

1. Start with no `RENDER_DIALECT` set and a reader who has never opened preferences.
2. Open any verse containing `labor`, `armor`, or `honor`.
3. **Expect**: American spelling. The published text, unaltered.
4. **Expect**: the attribution shows no modification notice (FR-015).

A reader who has chosen nothing must never see altered text. If this fails, nothing else matters.

## Scenario 2 — Reader opts in (FR-008, US1)

1. Set the reader's dialect to Canadian in preferences.
2. Reopen the same verse.
3. **Expect**: `labour`, `armour`, `honour`.
4. **Expect**: `realize` unchanged — Canadian keeps the American form (US1/AC3).
5. **Expect**: the attribution now carries the modification notice, naming Canadian (FR-014).

## Scenario 3 — Two readers, one deployment (FR-016, SC-006)

The scenario that server-side substitution could not satisfy.

1. Sign in as reader A, set Canadian. In a separate browser profile, sign in as reader B, leave the
   default.
2. Both open the same verse.
3. **Expect**: A sees `labour` with the disclosure; B sees `labor` without it.
4. Reload both. **Expect**: no crossover — neither reader picks up the other's spelling from cache.

Step 4 is the regression test for research decision R1. A failure here means dialect leaked into
something cached per-card rather than per-reader.

## Scenario 4 — Typed recitation is not penalised (FR-013, SC-008)

1. As a reader on Canadian, open a card that accepts typed recitation.
2. Type the verse exactly as displayed, using the Canadian spellings shown.
3. **Expect**: no word marked wrong on account of spelling.
4. Repeat on American. **Expect**: the same, with American spellings.

## Scenario 5 — Capitalisation and markup (FR-003, FR-004, SC-003, SC-004)

1. Find a verse where a variant word appears sentence-initially, and one where it is fully
   capitalised.
2. **Expect**: `Labor`→`Labour`, `LABOR`→`LABOUR`.
3. Inspect the rendered HTML. **Expect**: keyword markup, heading structure, and phrase boundaries
   identical to the American render — only word content differs.

## Scenario 6 — Bad configuration (FR-010)

1. Set `RENDER_DIALECT=klingon`. Restart.
2. **Expect**: the server starts, and readers with no preference get American.
3. `PUT /api/preferences` with `{"dialect":"klingon"}`. **Expect**: `400`, and the reader's existing
   preference unchanged.

The asymmetry is deliberate — see the contract. A bad write is rejected; a bad stored value never
breaks a reader's session.

## Scenario 7 — Server serves published text (R1, licensing)

1. `curl` a render endpoint directly, authenticated, with any reader's dialect set to Canadian.
2. **Expect**: the response body contains `labor`, not `labour`.

The server emits the published text regardless of who asks. If this fails, substitution did not
fully move client-side and the licensing posture in `research.md` no longer holds.
