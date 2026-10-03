# Contract: `memorize_session_v2` extras caps

The wasm export keeps its signature and JSON shape:

```ts
memorize_session_v2(limit: number, now_secs: bigint): string // { verses, orphans }
```

```json
{
  "verses": [
    {
      "verseId": 1,
      "cardIds": [1],
      "conditionalCardIds": [1],
      "recitationCardId": 1,
      "hpCardId": 1,
      "cclCardId": 1
    }
  ],
  "orphans": [1]
}
```

Only the bounds change.

| Bound                                                        | Before                         | After                                                   |
| ------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------- |
| `verses`                                                     | at most `limit`                | unchanged                                               |
| heading (`HeadingPassage`) cards, attached plus in `orphans` | at most `limit`                | at most `limit` for heading and chapter-list _together_ |
| chapter-list (`ChapterClubList`) cards, same                 | at most `limit`                | (shared with the row above)                             |
| conditional orphans (`Ftv`, `VerseInHeading`, `VerseInClub`) | at most `limit` of _each_ kind | at most `limit` _together_                              |

Rules that hold after the change:

1. Heading and chapter-list cards that attach to a session verse (FR-008) fill the shared budget
   before any catch-up. When they alone exceed `limit`, those attaching later in session order are
   left out; they stay New and return as catch-ups.
2. At most one heading card and one chapter-list card attach to each session verse (unchanged);
   heading and chapter-list cards that fit the budget but find no free verse go in `orphans`.
3. Conditional orphans come only from memorized verses outside the session (unchanged since 0.12.1),
   one per heading and one per club tier (unchanged), after any heading and chapter-list entries in
   `orphans`.
4. With no verses to serve, every heading and chapter-list card is a catch-up in `orphans`, and both
   budgets still apply.
5. Nothing left out is changed: it stays New, so a later session offers it.
6. In a year whose deck draws every verse from one book, a verse's `cardIds` leave out its
   which-book (`VerseInBook`) card; `graduate_verse` still graduates it with the verse.

Consumers: `apps/web` (`engineStore.memorizeSession`) and `packages/api` (`routes/cards.ts`). Each
calls once per enrolled year with that year's `lessonBatchSize`, which makes every bound per year.
