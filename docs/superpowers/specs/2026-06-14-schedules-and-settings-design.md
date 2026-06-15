# Schedules + per-club settings design

Per-material customizable schedules, per-club memorize/review configuration, and a restructured
`/settings` page to host both. Replaces the current "scope ladder" model with a richer per-club
shape so quizzers can lock to their league's calendar without losing self-paced flexibility.

## Goals

* Each enrolled material carries a **schedule** — the publicly distributed calendar of which verses
  are due by which date for each club tier — that the user can edit (shift day-of-week, move verses
  between weeks, add or remove weeks, manage major checkpoints / meets).
* `/memorize` becomes **schedule-aware**: it can either follow the calendar's pace or work
  sequentially through whichever verses the user hasn't memorized yet, with the choice made
  per-club.
* Multiple clubs (Club 150, Club 300, Full) compose cleanly: the user can lock Club 150 to the
  calendar, treat Club 300 as a self-paced reservoir, and gate when Club 300 verses become eligible
  to surface.
* The default experience for a typical SK quizzer ("one verse per day, Club 150 only") stays trivial
  — most users never see the multi-club / cross-club controls.
* `/review` becomes per-club configurable: each club has its own enabled flag and desired retention
  target, so users can keep their must-know club sharp without over-reviewing the optional ones.
* `/settings` gets restructured into three top-level surfaces (Account, Preferences, Materials) so
  the schedule controls have a home, account chores migrate out of `/profiles`' kebab menus (closing
  [#92][issue-92]), and a real app-preferences surface exists for future work.

## Non-goals

* **Multiple schedules per material.** One schedule per user per material. If the user wants to
  follow a different plan, they edit theirs.
* **External schedule imports** (PDF upload, URL paste). Defaults ship in the repo; user-authored
  schedules are edited in the in-app editor only.
* **Pre-meet retention boost** and other schedule-coupled review behaviour. Reviews stay
  FSRS-driven; the schedule only influences memorize. (Considered and deferred — see Open
  questions.)
* **Renaming clubs** (e.g. "My required tier" instead of "Club 150"). Club identities stay fixed.
* **Multi-tier schedules beyond Club 150 / 300 / Full.** The existing tier taxonomy stands.

## Concepts

* **Material** — a year-deck (`materialId`, e.g. `3-corinthians`). Already exists.
* **Club** — `Club150` / `Club300` / `Full`. Already exists as `ClubTier`. Each verse is tagged with
  its most-specific tier; "Up300" includes Club150 ∪ Club300, "All" adds Full.
* **Schedule** — a per-material, per-season plan of which verses are introduced in which week. New
  concept.
* **Week** — one row of the schedule: a date, a passage range, and per-club lists of verse numbers
  introduced that week. May be marked as a Review week (no new verses).
* **Meet** (major checkpoint) — a dated event in the schedule (e.g. "Nov 21-23 First Weekend Quiz
  Meet, Heritage Alliance Church"). Used as a milestone for Knob 2's "after major checkpoint" gate.
* **Catch-up behaviour** (Knob 1, per-club) — Sequential or Calendar cascade. Determines how a
  club's pool is ordered when the user is behind the calendar.
* **Move-to-next-club gate** (Knob 2, per adjacent pair) — Fully memorized / Major checkpoint /
  Minor checkpoint / Caught up / Always. Determines when a lower-priority club's pool becomes
  eligible.

## Schedule data model

### Bundled default (ships with deck)

Lives at `data/schedules/<deck>-<season>.json`, e.g. `data/schedules/3-corinthians-2025-26.json`.
One file per (deck, season). Read-only canonical version.

```json
{
  "version": 1,
  "materialId": "3-corinthians",
  "season": "2025-26",
  "title": "SK Quiz 2025-26 — 1 & 2 Corinthians",
  "meetingDayOfWeek": "Mon",
  "weeks": [
    {
      "date": "2025-09-08",
      "passage": "1 Cor 1:1-31",
      "verses": {
        "Club150": [5, 10, 17, 18, 21, 25, 27],
        "Club300": [1, 2, 4, 8, 9, 19, 23]
      },
      "isReview": false
    },
    {
      "date": "2025-11-17",
      "passage": null,
      "verses": null,
      "isReview": true
    },
    "..."
  ],
  "meets": [
    {
      "id": "first-weekend",
      "name": "First Weekend Quiz Meet",
      "startDate": "2025-11-21",
      "endDate": "2025-11-23",
      "location": "Heritage Alliance Church"
    },
    {
      "id": "final-weekend",
      "name": "Final Weekend Quiz Meet",
      "startDate": "2026-05-01",
      "endDate": "2026-05-03",
      "location": "Briercrest College, Caronport, SK"
    }
  ]
}
```

Notes:

* Verse numbers in `verses.{tier}` are verse numbers **within the row's `passage`** — i.e.
  `[5, 10, ...]` against passage `1 Cor 1:1-31` means 1 Cor 1:5, 1:10, etc. Keeps the JSON visually
  close to the source PDF and short.
* `verses.Club300` lists Club 300-tagged verses _additional_ to Club 150 (matches the PDF
  convention). Club 150 verses are not duplicated in the Club 300 list.
* Verses for the implicit "Full" tier are derived: any verse in the row's `passage` that is not in
  `Club150` or `Club300` is in Full's contribution for that week.
* `isReview: true` rows: no new verses introduced; the user's expected position doesn't advance for
  that week. Useful for pacing display.
* `meetingDayOfWeek` defines the canonical week-start. The user can override per-material in their
  personal copy.

### User customization (per-user)

Stored in the API's SQLite DB, one row per (user, material). When the user makes their first edit,
the bundled default is copied into the DB row as a starting point; subsequent edits mutate the copy.
A "Reset to default" action drops the row, falling back to the bundled file.

Schema (Drizzle-style):

```ts
materialSchedules {
  userId: string,
  materialId: string,
  scheduleJson: text,   // same shape as bundled file
  updatedAt: integer,   // unix-secs
  PRIMARY KEY (userId, materialId)
}
```

The full-copy approach is fine: schedules are small (~5KB per season). Avoids diff/merge logic and
makes "reset to default" trivial. Sync via the existing event log (one event per edit, the event
carries the new full JSON).

## Per-material settings model

Today's `MaterialConfig` (in `crates/core/src/material_config.rs`) carries
`{new_scope, review_scope, heading_card, heading_passage_card, ftv, club_card_scope, chapter_list_scope}`
plus material-wide `desiredRetention`. The new model splits the scope axes into per-club shapes.

### New shape

```rust
pub struct MaterialConfig {
    // Card-kind toggles — unchanged.
    pub heading_card: bool,
    pub heading_passage_card: bool,
    pub ftv: bool,
    pub club_card_scope: TierScope,        // unchanged: which clubs get "which club?" card
    pub chapter_list_scope: ChapterListScope,  // unchanged

    // NEW: per-club memorize config
    pub memorize: ClubMap<ClubMemorizeConfig>,

    // NEW: cross-club gates (per adjacent pair)
    pub move_to_next: MoveToNextConfig,    // see below

    // NEW: per-club review config (replaces flat review_scope + desired_retention)
    pub review: ClubMap<ClubReviewConfig>,

    // Session knob — unchanged in name, default changes 5 → 1
    pub lesson_batch_size: u8,
}

pub struct ClubMemorizeConfig {
    pub enabled: bool,
    pub catch_up: CatchUp,
}

pub enum CatchUp { Sequential, CalendarCascade }

pub struct MoveToNextConfig {
    pub p150_to_300: MoveToNextGate,
    pub p300_to_full: MoveToNextGate,
}

pub enum MoveToNextGate {
    FullyMemorized,
    AfterMajorCheckpoint,
    AfterMinorCheckpoint,
    CaughtUp,
    Always,
}

pub struct ClubReviewConfig {
    pub enabled: bool,
    pub desired_retention: f32,  // 0.50 - 0.90, default 0.80
}

pub type ClubMap<T> = (T, T, T);  // (Club150, Club300, Full); shape TBD in implementation
```

### Defaults (new enrolled material)

| Field                       | Value                                         | Rationale                                                                         |
| --------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------- |
| `memorize.Club150`          | `{ enabled: true, catch_up: Sequential }`     | "One verse a day" majority case.                                                  |
| `memorize.Club300`          | `{ enabled: false, catch_up: Sequential }`    | Most quizzers do Club 150 only.                                                   |
| `memorize.Full`             | `{ enabled: false, catch_up: Sequential }`    | Same.                                                                             |
| `move_to_next.p150_to_300`  | `CaughtUp`                                    | Permissive once the user enables Club 300 — they enabled it because they want it. |
| `move_to_next.p300_to_full` | `CaughtUp`                                    | Same.                                                                             |
| `review.Club150`            | `{ enabled: true, desired_retention: 0.80 }`  | Reasonable default for quizzing.                                                  |
| `review.Club300`            | `{ enabled: false, desired_retention: 0.80 }` | Paused until user opts in.                                                        |
| `review.Full`               | `{ enabled: false, desired_retention: 0.80 }` | Same.                                                                             |
| `lesson_batch_size`         | `1`                                           | Matches the one-verse-a-day pace; current default 5 is wrong for typical use.     |
| Card-kind toggles           | Unchanged from today's defaults.              |                                                                                   |

### Migration from today's shape

For existing users, derive the new per-club shape from the existing flat fields:

| Existing                            | New                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `new_scope = Off`                   | All `memorize.{club}.enabled = false`.                                                                 |
| `new_scope = Up150`                 | Only `memorize.Club150.enabled = true`.                                                                |
| `new_scope = Up300`                 | `memorize.Club150.enabled = memorize.Club300.enabled = true`.                                          |
| `new_scope = All`                   | All three `memorize.{club}.enabled = true`.                                                            |
| `review_scope`                      | Same mapping for `review.{club}.enabled`.                                                              |
| `desired_retention` (material-wide) | Applied to every enabled `review.{club}.desired_retention`.                                            |
| `lesson_batch_size`                 | Preserved as-is.                                                                                       |
| `move_to_next`                      | Set to `CaughtUp` for all pairs (matches the new default).                                             |
| `catch_up` per club                 | Set to `Sequential` for all clubs (matches the new default; existing users had no equivalent setting). |

The migration is a one-shot DB transformation at first read after the upgrade. Old wire format still
accepted via serde aliases for one release.

## Memorize algorithm

### Per-click cascade

Each tap of Memorize builds the next `lesson_batch_size` verses (default 1) and runs them through
the existing read → drill → reading-end flow.

For each click:

1. For each enabled club in priority order [Club150, Club300, Full]:
   * Build the club's **ordered pool** per its `catch_up` setting.
2. Apply the cross-club gates (`move_to_next`) to determine which clubs' pools are eligible to
   contribute right now.
3. Walk the eligible pools to fill `lesson_batch_size` verses, respecting:
   * The priority order of clubs.
   * The within-level interleave rule for backlog (see below).
   * The soft cap rule.

### Per-club pool ordering (Knob 1)

For a club with mode `Sequential`:

* Pool = the un-memorized verses in this club's sequence (passage order across the deck), in order.
* Unbounded — pulls forward through the season as needed.

For a club with mode `CalendarCascade`:

* **Primary** = un-memorized verses in this week's calendar row for this club.
* **Backlog** = un-memorized verses from prior weeks' rows for this club, in reverse-chronological
  order (most recent missed week first).
* **Lookahead** = un-memorized verses from future weeks' rows for this club, in order.
* The pool walks Primary → Backlog → Lookahead.

### Cross-club gates (Knob 2)

For each adjacent pair (`Club150 → Club300`, `Club300 → Full`), the gate condition determines when
the lower club's pool becomes eligible.

| Gate                   | Eligible when…                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FullyMemorized`       | Every verse in the higher club is memorized.                                                                                                                                        |
| `AfterMajorCheckpoint` | The higher club's verses through the most recent past meet are all memorized. If no meet has occurred yet, the gate is never open (lower club waits until the season's first meet). |
| `AfterMinorCheckpoint` | The higher club's verses through this week's row are all memorized.                                                                                                                 |
| `CaughtUp`             | The higher club's user position ≥ previous week's checkpoint position. At season start (before any weeks have elapsed), the gate is open by default.                                |
| `Always`               | No gate; lower club always eligible.                                                                                                                                                |

For `CalendarCascade` clubs, "user position" means count of verses memorized; "checkpoint position"
means cumulative verses through that week. For `Sequential` clubs, the same comparison applies — the
sequence pointer is the user position.

### Backlog interleave rule

When the higher club is in `CalendarCascade` mode and has backlog, that backlog drops down to the
next club's priority level. A `Sequential` club has no separate backlog vs primary — its entire pool
sits at the club's own level. Effective levels in a fully-enabled three-club material:

* **Level 1** (Club 150): Club 150's pool (primary verses if `CalendarCascade`; the whole Sequential
  pool if `Sequential`).
* **Level 2** (Club 300): Club 150 backlog (only if Club 150 is `CalendarCascade`) ∪ Club 300's pool
  (interleaved within the level if both present, round-robin).
* **Level 3** (Full): Club 300 backlog (only if Club 300 is `CalendarCascade`) ∪ Full's pool
  (interleaved).

The cross-club gate gates the lower club's pool from entering its level. Higher club's backlog
enters the next level regardless of the gate — it's not "the lower club," it's "this club's missed
verses."

### Soft cap

`lesson_batch_size` is a soft cap. A `CalendarCascade` club's **primary** pool is always included in
full, even if it overflows the cap. The cap only constrains backlog, lookahead, and lower-priority
clubs' contributions.

Example (with `lesson_batch_size = 5` for illustrative overflow — the new default is 1): Club 150 in
`CalendarCascade`, this week has 7 primary verses. The session has 7 verses (soft-cap overflow);
lower clubs contribute 0.

### Single-club default flow

For the typical user (Club 150 enabled, others off, `lesson_batch_size = 1`, catch-up Sequential):

1. Sequential pool for Club 150 = next un-memorized verse in sequence.
2. No other clubs eligible.
3. Fill 1 verse from Club 150's pool.

Result: each tap of Memorize shows one verse. UI shows it immediately and goes straight into the
existing read → drill flow.

### Memorize-ahead

A "Memorize ahead…" link on the preflight (visible whenever a single-verse default would otherwise
auto-start) opens a multi-verse picker. The user can:

* Increase the count for this session only (e.g. "memorize 7 verses today").
* Pick specific verses from any enabled club (visualised by week / by tier).
* Override the per-club mode for this session ("treat Club 150 as Sequential for today even though
  my setting is CalendarCascade").

Per-session overrides do not persist.

## Review algorithm changes

### Per-club enable

Replace `review_scope` with `ClubMap<ClubReviewConfig>`. A verse is eligible for /review if its
most-specific club's `review.{club}.enabled` is true.

The existing `next_card` (in `crates/core/src/schedule.rs`) filters by this set instead of the flat
`review_scope`. Cooldown, target-retention threshold, and most-overdue selection are unchanged.

### Per-club desired retention

Today's `ScheduleParams.target_retention` is per-material. Becomes per-club: when computing "is this
card due?" and "when is this card next due?", use the card's club's `desired_retention` instead of a
material-wide value.

`FsrsBridge::due_at` and `retrievability_of` already take a `target_r: f32` parameter; we just need
to thread the per-club value through the scheduler call sites.

UI surface: a slider per enabled club in the "What to review" section. Range 50-90% (down from the
current 70-97% — quizzers don't push as high as long-term-retention apps). Default 80% (down from
90%).

## Settings page IA

### Top-level structure

`/settings` becomes a three-section host:

| Section         | Route                   | Contents                                                                                                                                  |
| --------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Account**     | `/settings/account`     | Export my data · Import data · Delete all progress (migrating [#92][issue-92] from `/profiles`'s kebab).                                  |
| **Preferences** | `/settings/preferences` | App-wide prefs. Theme (when implemented), notification settings (when implemented). Empty section is fine at launch — see Open questions. |
| **Materials**   | `/settings/materials`   | The existing per-material tabs. The default route for /settings is this section (matches today's behaviour).                              |

Nav: a left rail (desktop) or accordion (mobile) listing the three sections, with Materials expanded
to show the per-material tabs as sub-items.

### Per-material card

Inside `/settings/materials/<materialId>` (or `/settings/materials?tab=<id>`), each material card
has these sections:

1. **Header** — title, description, status pills, schedule editor link.
2. **What to memorize** — the chain UI (Layout A): per-club enable, per-club Knob 1, cross-club
   gates (only visible when both flanking clubs are enabled).
3. **What to review** — per-club enable + per-club retention slider. Parallel structure to "What to
   memorize" but simpler (no Knob 1, no gates).
4. **Card kinds** — existing toggles (heading_card, heading_passage_card, ftv, club_card_scope,
   chapter_list_scope) unchanged.
5. **Offline study** — existing offline-mode toggle.
6. **Session** — `lesson_batch_size`. The material-wide retention slider goes away (moved to
   per-club).

### Chain UI for "What to memorize"

Per the brainstorm Layout A:

* One card per club, in priority order [150, 300, Full].
* Each card has: club name, progress count, Enabled checkbox, Knob 1 dropdown (visible only when
  enabled).
* Between two cards: an indented row with a dashed left rule, showing "Move to <next club> when:
  <Knob 2 dropdown>". **Visible only when both flanking clubs are enabled.**
* Disabled cards render dim with just the Enable checkbox.

### Schedule editor link

The material card header shows "Edit schedule →" as a small link, routing to
`/schedule/<materialId>` (see next section).

## Schedule editor

Lives at `/schedule/<materialId>`. Linked from the per-material settings card. Reads the user's
personal schedule if present, else the bundled default.

### Capabilities

* **Day-of-week shift**: a single setting at the top — "Meeting day: <day-picker>". Shifts every
  week's date by the delta. Affects the whole season uniformly.
* **Per-week edit**: each week is a row showing date, passage, per-tier verse lists. Click a week to
  edit:
  * Change the date (overrides the day-of-week shift for this week only).
  * Edit the per-tier verse list (add/remove verses by number).
  * Mark/unmark as a Review week.
* **Add week**: insert a new row at a chosen date with a chosen passage. Useful for catch-up weeks
  or personal study weeks beyond the canonical season.
* **Remove week**: delete a row entirely.
* **Manage meets**: a section below the weeks list with add/edit/remove for meet entries.
* **Reset to default**: a button to drop the user's customisation and revert to the bundled
  schedule.

### Layout

A two-pane editor (desktop) or single-pane stacked (mobile). Left/top: timeline of weeks with meet
markers inline. Right/bottom: detail editor for the selected week or meet.

Detailed visual design is deferred to the implementation plan — this spec just locks the
capabilities and the data flow.

## API + WASM changes

### API endpoints

* `GET /api/materials/:id/schedule` — returns the user's schedule (their personal copy if present,
  else the bundled default).
* `PUT /api/materials/:id/schedule` — replaces the user's schedule (full JSON). Validates shape,
  persists to `materialSchedules`.
* `DELETE /api/materials/:id/schedule` — drops the user's personal copy; defaults reapply.
* Extend `GET /api/years` (or whatever surfaces `YearView`) to include the per-club shapes for
  memorize and review. Backward-compatible additive change.
* Extend `PUT /api/materials/:id/settings` to accept the new per-club shapes; old shape still
  accepted for one release for client compatibility.

### WASM bindings

* New: `memorize_session_v2(material_id, settings, schedule, now_secs, batch_size)` returning the
  next `batch_size` verses' worth of items (verses + standalone cards). Old `memorize_session` stays
  for one release; deprecate after.
* The scheduler's `next_card` (already used by /review) gains a per-club-retention-aware path.
  Existing call signature can stay if we route the per-club retention through `ReviewEngine` state
  rather than a parameter.

### Contract version bumps

Per `CLAUDE.md`'s contract crate discipline:

* `crates/core`: MAJOR bump (state shape changes — `MaterialConfig` schema breaks for serde unless
  aliased; event replay produces different state). Add the new types, keep serde aliases for old
  fields one release.
* `crates/wasm`: MAJOR bump (new function, deprecated old function, settings JSON shape changes).

## Storage (DB)

New table:

```sql
CREATE TABLE materialSchedules (
  userId      TEXT NOT NULL,
  materialId  TEXT NOT NULL,
  scheduleJson TEXT NOT NULL,
  updatedAt   INTEGER NOT NULL,
  PRIMARY KEY (userId, materialId)
);
```

`MaterialConfig` migration: the existing `materialSettings` (or equivalent) table column storing the
JSON-encoded config grows. Add a one-shot migration to rewrite existing rows into the new shape,
falling through serde aliases for new readers in the interim.

## Implementation phases

The design is one coherent piece but the implementation decomposes into three trains that can ship
independently:

1. **Phase 1 — Core + WASM + API** (foundation). New `MaterialConfig` shape, new schedule JSON
   shape, new `memorize_session_v2` algorithm, per-club retention in the scheduler, DB migration,
   API endpoints. Existing UI continues to work against the new shape via the migration. Bumps
   `crates/core` and `crates/wasm` MAJOR.

2. **Phase 2 — Web settings restructure**. Three-section IA (Account / Preferences / Materials),
   Account section migration from `/profiles` (closes [#92][issue-92]), per-material card with the
   chain UI (Layout A) for memorize and the per-club slider section for review. Lets the user
   actually configure the Phase 1 mechanics.

3. **Phase 3 — Schedule editor**. New `/schedule/<materialId>` route with the editing capabilities
   listed above. Until shipped, users can only customise settings — schedule stays at the bundled
   default.

Each phase is a separate implementation plan and a separate PR train. Phase 1 unblocks Phase 2 and
3; Phase 2 and 3 are independent of each other.

## Open questions

* **Preferences section contents at launch.** Theme exists in the nav backlog. Anything else worth
  shipping with the IA change? Notification settings? Default `lesson_batch_size` preference? Picked
  up during Phase 2 planning.
* **"Caught up" definition precision.** Current spec says "user position ≥ previous week's
  checkpoint." Does "previous week" mean the week before today, or the most-recent past scheduled
  week (skipping Review weeks)? Leaning toward most-recent past scheduled week with new verses.
* **Schedule diff at sync time.** Once schedules are user-editable and sync'd, two devices editing
  the same schedule diverge. Last-write-wins is the simplest answer (matches the rest of the sync
  model); confirm during Phase 1 implementation.
* **Reset-to-default UX.** A destructive action (drops user edits). Confirm dialog? Type-to-
  confirm? Probably just a single confirm dialog given schedules are recoverable from the
  source-of-truth bundled file.
* **"Add week" passage picker.** Adding a week requires picking a passage range. UI for that is
  deferred; might be a simple text input ("1 Cor 5:1-13") with a parse + validation pass.
* **Memorize-ahead persistence.** Per-session overrides don't persist (locked above). But should
  there be a "save these settings to my default" shortcut on the preflight? Probably not for v1 —
  keep the model clean.
* **`club_card_scope` and `chapter_list_scope` consistency.** These still use the old TierScope
  ladder (Off / Up150 / Up300 / All). They could be reshaped to per-club booleans for consistency
  with the new model — leaning toward "do it during Phase 1 since we're already touching
  `MaterialConfig`" but the existing ladder is also fine to leave as-is. Decide during Phase 1
  planning.

## Decisions log

For future-me reference. All confirmed during the 2026-06-14 brainstorm session.

* Schedules ship per material in `data/schedules/<deck>-<season>.json`. ✓
* User clones to DB on first edit. ✓
* Per-club enabled flag replaces the "Off" mode. ✓
* Knob 1 (Catch-up) per-club: Sequential / Calendar cascade. Calendar-only dropped. ✓
* Knob 2 (Move-to-next) per adjacent pair: five options as listed. ✓
* Defaults: Club 150 = enabled + Sequential; 300/Full = off; gates = Caught up. ✓
* `lesson_batch_size` default: 1 (down from 5). ✓
* Soft cap rule: Calendar-cascade primary pool overflows the cap. ✓
* Backlog from Calendar-cascade drops to next club's level, interleaved. ✓
* Strict "Fully memorized" gate drains the higher club entirely. ✓
* Single-click memorize: next N verses, drill, done. ✓
* "Memorize ahead" preflight for multi-verse / power-user sessions. ✓
* Inter-club gate UI only visible when both flanking clubs are enabled. ✓
* Review per-club: enabled + desired retention. ✓
* Retention range: 50-90%, default 80%. ✓
* Settings IA: Account / Preferences / Materials. ✓
* Chain UI (Layout A) for clubs within material. ✓
* Schedule editor: separate route `/schedule/<materialId>`. ✓

[issue-92]: https://github.com/TommyAmberson/verse-vault/issues/92
