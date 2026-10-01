# Quickstart: Validating "Memorize by Schedule"

**Date**: 2026-09-24 | **Plan**: [plan.md](./plan.md)

Three checks, in the order they run during implementation. The simulator baseline must be captured
before the core change lands.

## 1. Simulator baseline (current queue)

Run once the sim's `--memorize` mode exists and before the core change:

```bash
cargo run -p verse-vault-sim --release -- --memorize \
  --out specs/003-memorize-by-schedule/sim-baseline.tsv
```

`sim-baseline.tsv` holds every season, setting and learner's outcome for §2 to compare against.
Record the outcomes per season and learner (verses memorized, mean wait in days from becoming owed
to memorized, invariant failures), the failures per setting, and the mean time per `memorize_debt`
and `next_memorize_batch` call in the tables below. Each season-and-learner row covers every gate,
catch-up and batch-size setting: verses memorized is the mean per setting, the mean wait is over
every scheduled verse in every setting, and failures are summed. Invariant failures are expected
here: the current queue violates SC-001, SC-002, SC-005 and SC-006 in some states, which is the
point of the feature.

Baseline recorded 2026-10-01 against core 0.11.0, in 26 s.

| Season              | Learner | Verses memorized | Mean wait (days) | Invariant failures |
| ------------------- | ------- | ---------------- | ---------------- | ------------------ |
| GEPC 2023-24        | On plan | 499.3            | 32.75            | 5111               |
| GEPC 2023-24        | Behind  | 464.3            | 43.11            | 4973               |
| GEPC 2023-24        | Ahead   | 503.0            | 10.37            | 5714               |
| NT Survey 2024-25   | On plan | 788.3            | 31.09            | 7685               |
| NT Survey 2024-25   | Behind  | 710.3            | 44.42            | 6890               |
| NT Survey 2024-25   | Ahead   | 812.0            | 10.81            | 11922              |
| Corinthians 2025-26 | On plan | 668.0            | 18.20            | 3616               |
| Corinthians 2025-26 | Behind  | 624.0            | 27.97            | 3449               |
| Corinthians 2025-26 | Ahead   | 694.0            | 4.99             | 1936               |
| John 2026-27        | On plan | 850.2            | 16.28            | 3582               |
| John 2026-27        | Behind  | 777.2            | 29.07            | 3404               |
| John 2026-27        | Ahead   | 879.0            | 4.52             | 1986               |

Per setting, over every season and learner; verses memorized is the mean per season and learner.
"Oversized" is calendar cascade's soft cap (FR-008), "count vs batch" a count above zero with
nothing served under a checkpoint gate (FR-007), "not owed" a verse served before its week (SC-005),
and "not nearest week" working ahead out of schedule order (SC-002). Sequential catch-up waits about
three times as long as calendar cascade because deck order ignores the schedule.

| Gates (150→300 / 300→Full)                  | Catch-up        | Batch | Verses memorized | Mean wait (days) | Count vs batch | Not owed | Oversized | Not nearest week |
| ------------------------------------------- | --------------- | ----- | ---------------- | ---------------- | -------------- | -------- | --------- | ---------------- |
| Always / CaughtUp                           | Sequential      | 1     | 702.0            | 19.76            | 0              | 1866     | 0         | 146              |
| Always / CaughtUp                           | Sequential      | 5     | 702.0            | 19.77            | 0              | 1865     | 0         | 146              |
| Always / CaughtUp                           | CalendarCascade | 1     | 702.0            | 6.66             | 0              | 129      | 1451      | 549              |
| Always / CaughtUp                           | CalendarCascade | 5     | 702.0            | 6.69             | 0              | 137      | 1200      | 549              |
| Always / Always                             | Sequential      | 1     | 702.0            | 19.80            | 0              | 1914     | 0         | 146              |
| Always / Always                             | Sequential      | 5     | 702.0            | 19.80            | 0              | 1914     | 0         | 146              |
| Always / Always                             | CalendarCascade | 1     | 702.0            | 6.47             | 0              | 48       | 1493      | 549              |
| Always / Always                             | CalendarCascade | 5     | 702.0            | 6.47             | 0              | 48       | 1271      | 549              |
| CaughtUp / CaughtUp                         | Sequential      | 1     | 702.0            | 19.76            | 0              | 1866     | 0         | 146              |
| CaughtUp / CaughtUp                         | Sequential      | 5     | 702.0            | 19.77            | 0              | 1863     | 0         | 146              |
| CaughtUp / CaughtUp                         | CalendarCascade | 1     | 702.0            | 6.79             | 0              | 140      | 1461      | 549              |
| CaughtUp / CaughtUp                         | CalendarCascade | 5     | 702.0            | 6.86             | 0              | 136      | 1164      | 549              |
| FullyMemorized / FullyMemorized             | Sequential      | 1     | 702.0            | 30.29            | 0              | 3488     | 0         | 78               |
| FullyMemorized / FullyMemorized             | Sequential      | 5     | 702.0            | 30.29            | 0              | 3488     | 0         | 78               |
| FullyMemorized / FullyMemorized             | CalendarCascade | 1     | 702.0            | 29.11            | 0              | 3459     | 537       | 78               |
| FullyMemorized / FullyMemorized             | CalendarCascade | 5     | 702.0            | 29.11            | 0              | 3459     | 356       | 78               |
| AfterMajorCheckpoint / AfterMajorCheckpoint | Sequential      | 1     | 626.5            | 50.90            | 387            | 2395     | 0         | 60               |
| AfterMajorCheckpoint / AfterMajorCheckpoint | Sequential      | 5     | 626.5            | 50.88            | 387            | 2397     | 0         | 60               |
| AfterMajorCheckpoint / AfterMajorCheckpoint | CalendarCascade | 1     | 626.5            | 49.85            | 387            | 2241     | 665       | 60               |
| AfterMajorCheckpoint / AfterMajorCheckpoint | CalendarCascade | 5     | 626.5            | 49.87            | 387            | 2243     | 479       | 60               |
| AfterMinorCheckpoint / AfterMinorCheckpoint | Sequential      | 1     | 700.3            | 19.99            | 10             | 1958     | 0         | 146              |
| AfterMinorCheckpoint / AfterMinorCheckpoint | Sequential      | 5     | 700.3            | 20.25            | 10             | 2217     | 0         | 146              |
| AfterMinorCheckpoint / AfterMinorCheckpoint | CalendarCascade | 1     | 700.3            | 7.18             | 10             | 283      | 1512      | 549              |
| AfterMinorCheckpoint / AfterMinorCheckpoint | CalendarCascade | 5     | 700.3            | 7.79             | 10             | 626      | 802       | 546              |

| Call                  | Mean time |
| --------------------- | --------- |
| `memorize_debt`       | 133 µs    |
| `next_memorize_batch` | 206 µs    |

## 2. Simulator after the change

On the branch with the new queue, compare against the stored baseline:

```bash
cargo run -p verse-vault-sim --release -- --memorize \
  --baseline specs/003-memorize-by-schedule/sim-baseline.tsv
```

**Expected**:

* Zero invariant failures in every combination (SC-001, SC-003, SC-005, SC-006, SC-002).
* No combination of season, setting and learner regressed: verses memorized at least the baseline
  and the mean wait no longer (SC-004).
* Mean call times within 10% of the baseline's (plan Performance Goals).

## 3. The app, on real data

Against a copy of production data, or after deploy, for an account enrolled in John with Club 300
behind (the 2026-09-24 state of `tommyamberson@gmail.com`):

1. Note the Memorize pill's number.
2. Press Memorize and check each verse served is one the schedule has already assigned.
3. Memorize the batch; the number drops by the verses finished.
4. Once caught up, press Memorize: the verses come from the nearest future week's list.

## Regression checks

```bash
cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check
wasm-pack build crates/wasm --target nodejs --out-dir pkg && node crates/wasm/test-smoke.js
pnpm test
dprint check && typos && tools/check-contract-versions.sh --pr master
```
