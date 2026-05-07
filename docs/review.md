# Review pipeline

How a graded card turns into per-test FSRS updates. For the memory model behind these updates see
[`path-posterior-memory-model.md`](path-posterior-memory-model.md); for the verse-element substrate
see [`graph.md`](graph.md); for what the scheduler does with the resulting state see
[`scheduling.md`](scheduling.md).

## The shape of a review

`ReviewEngine::review(card_id, grades, now_secs)` is the single entry point. It takes a per-test
grade map and returns a `ReviewOutcome` listing every test it touched, tagged `Direct` or
`Propagated`. The pipeline is small enough to state in full:

1. Look up the card and its `VerseAtoms`.
2. Compute `card.tests(atoms)` and assert that `grades.keys()` matches it exactly. (Mismatch panics
   — the engine refuses to silently skip or seed.)
3. **Build the propagation set, deduped.** For each direct, fan out
   `propagate::related_tests(direct, …)`. Drop targets that are themselves direct-graded this
   review. If multiple directs propagate to the same target, keep the highest-weight edge.
4. For each `(test, grade)` pair, apply `FsrsBridge::direct_step` and record a `Direct` update.
5. For each (deduped) propagation target, apply `FsrsBridge::propagated_step` with the chosen grade
   and weight; record a `Propagated` update.

That's it. No path enumeration, no source-set expansion, no fallback chain, no anchor transfer. All
of that machinery from the legacy 6-step credit-assignment algorithm was subsumed by per-test state
plus HSRS-style propagation.

The dedup in step 3 is load-bearing. It mirrors HSRS's `getLearningCardDiff` (which dedupes
flattened learnings via `_.uniqBy(res, l => l.cardId)`) so each `TestKey` receives **at most one
update per review**. Without it, a composite card like `Holistic` — which directly grades both
phrase and binding tests — would re-touch a binding's freshly-stamped state with `elapsed = 0`,
falling into `invert_r`'s `r ≈ 1.0` branch and saturating stability to `S_MAX`. A real direct grade
is stronger evidence than any partial nudge a related test could supply, so the directs win and the
propagation is dropped.

## Cards grade tests, not atoms

In the new model a card is a routing object: given the verse's `VerseAtoms` it tells you _which
`TestKey`s this review will grade_. `Card::tests` is pure — same card + atoms always yields the same
set:

| Card kind               | Tests graded                                                |
| ----------------------- | ----------------------------------------------------------- |
| `PhraseFill { p }`      | 1 — `PhraseFromContext` at phrase `p`                       |
| `PhraseChain { p }`     | 1 — `PhraseFromChain` at phrase `p`                         |
| `VerseAtVerseRef`       | 1 — `VerseRefPosition` binding                              |
| `VerseInChapter`        | 1 — `VerseChapter` binding                                  |
| `VerseInBook`           | 1 — `VerseBook` binding                                     |
| `VerseInHeading`        | 1 — `VerseHeading` binding                                  |
| `VerseInClub`           | 1 — `VerseClub` binding                                     |
| `Recitation`            | N — `PhraseFromChain` for every phrase                      |
| `Citation`              | 3 — `VerseRefPosition`, `VerseChapter`, `VerseBook`         |
| `Ftv { with_citation }` | phrases (less FTV prefix) + optionally the 3 citation tests |
| `Holistic`              | N phrases + 3 citation bindings                             |
| `Reading`               | 0 — UX-only progressive-reveal card, never persisted        |

The grade map the caller passes to `review` therefore has one entry per test, not one entry per atom
— the unit of FSRS observation is the test, in keeping with the canonical spec.

## Direct vs. propagated updates

`FsrsBridge` exposes two update primitives:

* `direct_step(state, grade, now_secs)` — full FSRS-6 transition. Advances all three timestamps
  (`last_seen_secs`, `last_base_secs`, `last_root_secs`) to `now_secs`.
* `propagated_step(state, grade, weight, now_secs)` — HSRS-style partial update. Interpolates in
  retrievability space between the current state and the hypothetical post-direct state by
  `weight ∈ [0, 1]`, blends difficulty linearly, and blends `last_base_secs` linearly. Crucially, it
  **never advances `last_root_secs`** — propagation cannot impersonate a direct review. That
  invariant is what stops propagated tests from looking like recently-rehearsed ones to the
  scheduler.

`weight` for a propagation update is the product of two factors:

* **Bayesian conditional probability share** `(1 − p_i) / (1 − p_total)` where `p_i` is the test's
  pre-review retrievability and `p_total = ∏ p_j` is the joint probability over every test in the
  observation (directs + propagation targets). This concentrates credit on tests where the outcome
  was least expected — a binding that was about to lapse gets a stronger nudge from a successful
  Recitation than a binding that was already strong. Mirrors HSRS's
  `(1 - successProb) / (1 - totalSuccessProb)` in `getLearningCardDiff`.

* **Static edge gamma** from `PropagationParams`:
  * `gamma_sibling = 0.5` for same-element opposite-cuing-direction phrase edges (a
    `PhraseFromChain` direct lifts the matching `PhraseFromContext`).
  * `gamma_endpoint = 0.07` for endpoint↔binding edges (phrase ↔ verse binding tests, in either
    direction).

  These edge weights encode verse-vault's D4 architecture choice — that endpoint signal is weaker
  than sibling signal — and play the same role HSRS's depth-based retention offset plays in its tree
  topology.

Directs always get a full `direct_step` regardless of the Bayesian factor: in verse-vault every
direct carries an explicit user grade for that specific test, so the user's signal is the strongest
evidence available. Propagations get `bayesian × gamma`.

## related_tests

`propagate::related_tests(direct, idx, params)` returns the propagation fan for one direct test. The
two cases:

* **Phrase direct.** Emits the same-position opposite-cuing phrase test (weight `gamma_sibling`),
  plus every verse binding the verse has (`gamma_endpoint`).
* **Binding direct.** Emits both `PhraseFromChain` and `PhraseFromContext` for every phrase of the
  verse (`gamma_endpoint`).

The function returns `[]` for verses unknown to the index — propagation is verse-local by
construction.

## When directs share a propagation target

Composite cards can have two directs that propagate to the same target (e.g. a Recitation grades all
phrases directly, and each phrase propagates to the same `VerseChapterBinding`). The engine keeps
**one** propagation per target — the highest-weight edge wins. The other directs' edges to the same
target are dropped. This matches HSRS's "one update per cardId per observation" invariant; layering
multiple partial updates on the same test in arrival order would compound soft evidence beyond what
any single direct grade represents.

If the target is itself in the direct set, the propagation is dropped entirely — see step 3 of the
pipeline above.

## Audit fixes folded in

The migration absorbed several issues from `audit-fsrs6-2026-04-28.md`:

* **B1 sinc clamp.** `stability_short_term` now clamps the
  `sinc = exp(w17·(rating-3+w18)) · S^(-w19)` factor at 1.0 for Hard/Good/Easy, so a Hard grade at
  `delta_t = 0` cannot decrease stability. Covered by
  `direct_step_hard_at_zero_delta_does_not_decrease_stability` in `fsrs_bridge.rs`.
* **B2 stability ceiling.** `direct_step` and `propagated_step` clamp stability to `[S_MIN, S_MAX]`,
  fixing the unconditional `.max(S_MIN)` the audit flagged.
* **S1 / S3 (linear stability blending, last-review reset on partial weight).** Resolved by
  construction: HSRS interpolates in retrievability space, and `last_root_secs` is preserved under
  propagation.
* **S2 (unbounded weight per edge).** Resolved by switching from a per-edge accumulator to
  per-direct fan-out with bounded `gamma_sibling` / `gamma_endpoint` weights.

## Out-of-app practice

The HSRS model accepts that learners practise outside the app. Because state is per-test rather than
tied to a specific path through a graph, an unexpectedly-strong direct review just produces a normal
FSRS update — no history-trace consistency check rejects it.
