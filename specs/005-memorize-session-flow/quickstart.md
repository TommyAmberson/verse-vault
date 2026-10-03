# Quickstart: validating the memorize session flow

## Prerequisites

`pnpm install` (hooks and workspace), a Rust toolchain with `wasm-pack`, and the decks in `data/`.

## Automated

```sh
cargo test -p verse-vault-wasm --test roundtrip   # extras caps (contracts/memorize-session.md)
cargo test -p verse-vault-core                     # core still builds without the progression
pnpm --filter @verse-vault/web test drillOrder    # pick rule (contracts/drill.md)
cargo clippy --all-targets -- -D warnings && pnpm test && dprint check && typos
```

Expected:

* Roundtrip: with `limit = 3` and more than 3 outstanding of each extra kind, a session holds at
  most 3 heading and chapter-list cards together and at most 3 orphans together; own heading and
  chapter-list cards win over catch-ups; a verse-less session obeys the same bounds; repeated
  sessions with graduation eventually offer every outstanding extra. In a single-book deck no
  verse's `cardIds` hold its which-book card, and graduating the verse still makes that card Active;
  a multi-book deck keeps it.
* Vitest: over at least 1,000 seeded drills mixing several verses, missed answers and extras, every
  run satisfies the four guarantees in [contracts/drill.md](./contracts/drill.md), and the
  missed-blank swap of research D2 is exercised.

## Manual (web dev server)

```sh
pnpm --filter @verse-vault/web dev
```

On an account with a few owed verses and outstanding extras, press Memorize:

1. The read phase lists the batch's verses first, their heading and chapter-list cards beside them,
   and orphans after; extras of each group number at most the batch size.
2. In the drill, each verse's blanks appear in phrase order, mixed with other verses' cards, and
   never the same verse twice in a row while others remain. Answer Again on a middle blank: the next
   blank of that verse can still appear, and the recitation does not appear until every blank is
   Good.
3. The closing read offers Graduate or Not yet per item; the summary counts graduated verses.

## Docs

`docs/memorize.md` describes the session as above; `docs/session.md` no longer describes a
progressive reveal; `grep -rn new_verse_progression crates docs` finds nothing.
