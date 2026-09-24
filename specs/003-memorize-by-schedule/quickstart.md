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

| Season | Learner | Verses memorized | Mean wait (days) | Invariant failures |
| ------ | ------- | ---------------- | ---------------- | ------------------ |
| _..._  | _..._   | _baseline_       | _baseline_       | _baseline_         |

| Gates | Catch-up | Batch | Verses memorized | Mean wait (days) | Count vs batch | Not owed   | Oversized  | Not nearest week |
| ----- | -------- | ----- | ---------------- | ---------------- | -------------- | ---------- | ---------- | ---------------- |
| _..._ | _..._    | _..._ | _baseline_       | _baseline_       | _baseline_     | _baseline_ | _baseline_ | _baseline_       |

| Call                  | Mean time  |
| --------------------- | ---------- |
| `memorize_debt`       | _baseline_ |
| `next_memorize_batch` | _baseline_ |

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
