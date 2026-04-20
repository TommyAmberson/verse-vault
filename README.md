# verse-vault

A Bible memorization app built for [QuizMeet](https://quizmeet.com) competitors and anyone who wants
to memorize scripture.

## What makes it different

Verse-vault uses an **edge-based memory graph** instead of traditional per-card spaced repetition.
Memory is modeled as transitions between pieces of information — not isolated facts. This means:

* **Phrases within a verse** are tracked separately, so the app knows which part you struggle with
* **Multiple recall paths** are recognized — if you know nearby verses, that helps you recall
  references
* **Cards are dynamically selected** based on which edges need the most efficient reinforcement
* **Club 150/300 verse lists** are first-class, with their own scheduling and membership drills

Built on [FSRS](https://github.com/open-spaced-repetition/fsrs-rs) (Free Spaced Repetition
Scheduler) with extensions for graph-based credit assignment and anchor transfer.

## Status

Core algorithm and simulation framework in development. See `docs/` for the full design.

## Structure

```
crates/
  core/     Rust library — graph, FSRS, credit assignment, scheduling (no I/O)
  sim/      Simulation binary — validates algorithm against synthetic data
docs/       Design docs — graph model, review algorithm, scheduling, validation
```

## Build

```
cargo test             # run all tests
cargo run -p verse-vault-sim   # run simulation
```
