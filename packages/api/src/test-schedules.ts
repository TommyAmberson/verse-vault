// Schedule payloads shared across the tests that exercise the v1→v2
// fold. Deliberately dependency-free: `test-fixtures.ts` reaches
// `enrollUser`, which loads the WASM engine at module scope, and the
// validator and migration suites that want these literals have no use
// for an engine.

/** A v1-wire schedule: one normal week and one review week, the shape
 *  every schedule was stored in before #103 canonicalised writes.
 *
 *  Shared so the folds that are supposed to agree — `migrateV1Week`,
 *  core's `ScheduleWeekRaw`, and migration 0025's SQL — are compared
 *  against one input rather than per-test copies that drift apart
 *  silently. */
export const V1_SCHEDULE = {
  version: 1,
  materialId: 'nkjv-cor',
  season: '2025-26',
  title: 'Test',
  meetingDayOfWeek: 'Mon',
  weeks: [
    {
      date: '2025-09-08',
      passage: { book: '1 Corinthians', chapter: 1, startVerse: 1, endVerse: 31 },
      verses: { club150: [5, 10], club300: [1, 2] },
      isReview: false,
    },
    {
      date: '2025-11-17',
      passage: null,
      verses: null,
      isReview: true,
    },
  ],
  meets: [],
};

/** The passage a v1 week may carry alongside `isReview: true` — the case
 *  every fold used to disagree on. */
export const REVIEW_WEEK_PASSAGE = {
  book: '1 Corinthians',
  chapter: 2,
  startVerse: 1,
  endVerse: 5,
};

/** A v1 review week that carries real content. Folds to one block
 *  everywhere; the browser and API used to drop it. */
export const V1_REVIEW_WEEK_WITH_PASSAGE = {
  ...V1_SCHEDULE,
  weeks: [{ date: '2025-11-17', passage: REVIEW_WEEK_PASSAGE, isReview: true }],
};

/** A v1 week carrying both wire shapes. No shipped client emits this;
 *  every fold resolves it by keeping `blocks` and ignoring the legacy
 *  pair. */
export const V1_WEEK_WITH_BOTH_SHAPES = {
  ...V1_SCHEDULE,
  weeks: [
    {
      date: '2025-09-08',
      blocks: [{ passage: REVIEW_WEEK_PASSAGE, verses: { club150: [3], club300: [] } }],
      passage: { book: 'Ignored', chapter: 9, startVerse: 9, endVerse: 9 },
      verses: { club150: [99], club300: [] },
      isReview: false,
    },
  ],
};
