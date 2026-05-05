# Path-posterior memory model

> **Status:** brainstorm. The verse-vault project is still working out its theory of memory — what
> units carry state, how observations propagate through the graph, what the graph actually
> contributes mathematically. This document proposes one coherent architecture that resolves several
> issues we ran into with the current edge-FSRS implementation, and sketches the math with multiple
> options where real design choices exist.

## Contents

* [Motivation](#motivation)
* [The three-layer model](#the-three-layer-model)
* [Notation](#notation)
* [Card state](#card-state)
* [Edge associations](#edge-associations)
* [Path posterior at review time](#path-posterior-at-review-time)
* [Edge updates via Bayesian inference](#edge-updates-via-bayesian-inference)
* [Card-to-card propagation](#card-to-card-propagation)
* [Multi-atom cards](#multi-atom-cards)
* [Verse-chunk layer (optional)](#verse-chunk-layer-optional)
* [Ground truth and drift prevention](#ground-truth-and-drift-prevention)
* [Open questions](#open-questions)

## Motivation

### What FSRS is actually built for

FSRS is a single-card single-grade single-update memory model: an atomic review event drives a (S,
D, t) update via empirically calibrated formulas. Its 21 parameters are fit to millions of Anki
reviews of approximately independent flashcards. It is gold for that regime.

### What verse-vault is actually doing

Verse-vault memorizes connected text, where:

1. **Items are sequenced.** Phrases of a verse are ordered; recall is traversal, not point-recall.
2. **Items share substrate.** Common phrasings recur across verses ("in the beginning", "and it came
   to pass"). Maximum interference baked into the content.
3. **Recall is hierarchical.** Users retrieve verse-as-chunk, which unfolds into phrases, which
   unfold into words.
4. **Each card touches many memorable units.** A full-recitation card tests every adjacency, gist,
   and ref-binding in the verse simultaneously.

None of this fits the atomic-card assumption FSRS was tuned for.

### Where the current edge-FSRS architecture struggles

The current architecture puts FSRS state on each edge of the memory graph and synthesizes credit
assignment to distribute card outcomes across edges. This has run into several structural issues:

* **Linear blending in stability space** for multi-grade updates produces pathological
  cancellations: `(Again, 0.5) + (Good, 0.5) ≈ 0` net change even when both observations carry
  information. (S1 in `docs/audit-fsrs6-2026-04-28.md`.)
* **Per-edge weight is unbounded across hidden atoms.** Hub edges participating in paths to multiple
  hidden atoms accumulate weights up to ~N. The FSRS update then applies "N full reviews' worth" of
  delta in one blend. (S2.)
* **`last_review_secs` is unconditionally reset** by any update, regardless of weight. A 5%-strength
  exposure update fully refreshes the decay clock, lying to the scheduler about how recently the
  edge was meaningfully reviewed. (S3.)
* **Out-of-app practice is invisible to history-trace memory models.** Quizzers practice constantly
  in many contexts; an algorithm that requires a complete observation record cannot recalibrate when
  reality contradicts prediction.
* **Edges cannot be directly tested in isolation.** Most edges in the graph (gist nodes, hub edges,
  ref-binding edges) cannot be probed without activating other edges, so HSRS-style "ground-truth"
  reviews of individual edges are mostly impossible.

These are not bugs in implementation; they are signs that the FSRS substrate is being asked to do
something it was not built for. Trying to patch them produces a growing collection of heuristics
with no unified theory.

### What this proposal does instead

This document proposes:

1. **Move FSRS state to cards**, where it has empirical calibration.
2. **Replace per-edge FSRS state with per-edge Hebbian-style association strengths**, which fit the
   cognitive role edges actually play.
3. **Use Bayesian inference over recall paths** at review time to attribute the observation across
   edges and propagate to related cards.

The path-posterior step is the mathematical contribution of the graph: it turns a card-level
observation into evidence about which edges fired, which propagates to other cards whose recall
flows through the same machinery. The audit issues dissolve because their preconditions
(FSRS-on-edges, partial-credit-on-FSRS) are removed.

## The three-layer model

Three layers of state, each with a distinct role and update rule:

```
┌─────────────────────────────────────────────────────────────┐
│ verse-chunk states (optional)                               │
│ - per-(verse, direction) FSRS state                         │
│ - updated by full-recitation observations                   │
│ - regularizes constituent card states                       │
└─────────────────────────────────────────────────────────────┘
            ↑                          ↓ (regularize)
┌─────────────────────────────────────────────────────────────┐
│ card states                                                 │
│ - per-card FSRS state                                       │
│ - updated directly on review                                │
│ - updated partially by propagation from related reviews     │
└─────────────────────────────────────────────────────────────┘
            ↑                          ↓ (read)
┌─────────────────────────────────────────────────────────────┐
│ path posterior (transient — recomputed each review)         │
│ - Bayesian inference over which paths fired                 │
│ - bridges card observation to edge/related-card updates     │
└─────────────────────────────────────────────────────────────┘
            ↑                          ↓
┌─────────────────────────────────────────────────────────────┐
│ edge associations                                           │
│ - scalar association strength a_e ∈ [0, 1] per edge         │
│ - Hebbian-style update via posterior weight                 │
│ - no FSRS dynamics, slow optional decay                     │
└─────────────────────────────────────────────────────────────┘
```

The verse-chunk layer is optional and additive; the core architecture is cards + edges + path
posterior.

## Notation

| Symbol          | Meaning                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| `c`             | a card                                                                                                |
| `e`             | an edge in the memory graph                                                                           |
| `π`             | a path: an ordered sequence of edges from a card's shown atoms to one of its hidden atoms             |
| `Π_c`           | the set of all paths for card `c` (typically up to some hop limit)                                    |
| `a_e`           | association strength of edge `e`, in `[0, 1]`                                                         |
| `R(π)`          | path probability under current associations: `R(π) = ∏_{e ∈ π} a_e`                                   |
| `S_c, D_c, t_c` | FSRS stability, difficulty, last-review-time of card `c`                                              |
| `R_c(t)`        | retrievability of card `c` at time `t`, computed from `(S_c, D_c, t_c)` via the FSRS forgetting curve |
| `g`             | a grade in `{Again, Hard, Good, Easy}` ↔ `{1, 2, 3, 4}`                                               |
| `α`             | Hebbian rate for edge association updates                                                             |
| `γ`             | propagation rate for card-to-card updates                                                             |
| `β`             | (in chunk layer) chunk influence rate for nudging constituent cards/edges                             |
| `λ_decay`       | (optional) slow decay rate for unused edge associations                                               |

## Card state

Each card carries full FSRS state:

```
struct CardState {
    stability: f32,             // S_c
    difficulty: f32,            // D_c
    last_seen_secs: i64,        // t_c — set on any touch
    last_root_secs: i64,        // last direct-review timestamp
}
```

The `last_root_secs` field tracks the most recent observation where this card was the explicit
subject of a review (rather than nudged via propagation). It serves the role HSRS gives `lastRoot` —
anchoring the state estimate to ground-truth observations and informing scheduler bias toward
stale-ground-truth cards.

### Direct review update

When card `c` is reviewed at time `t` with grade `g`:

```
(S_c, D_c) ← FSRS_step(S_c, D_c, t - t_c, g)
t_c ← t
last_root_secs ← t
```

Standard FSRS dynamics with the existing 21-parameter model. No partial credit, no path inference
involved here — `c` was directly observed.

### Propagated update

When another card `c'` is reviewed and the path posterior implicates shared structure with `c`, `c`
receives a partial FSRS update:

```
(S_c, D_c) ← FSRS_step_with_weight(S_c, D_c, t - t_c, g, w_propagation)
t_c ← interpolate(t_c, t, w_propagation)        // see "timestamp handling"
// last_root_secs unchanged — this was not a direct observation
```

The form of `FSRS_step_with_weight` is itself a design choice — see _Card-to-card propagation_
below.

### Timestamp handling

Direct reviews fully advance both `t_c` (for the forgetting curve) and `last_root_secs` (for
ground-truth tracking). Propagated updates partially advance `t_c` (proportional to propagation
weight) and leave `last_root_secs` alone.

The interpolation rule for partial updates follows HSRS:

```
t_c ← (1 - w) · t_c + w · t_now
```

with `w` being the effective propagation weight in `[0, 1]`.

## Edge associations

Each edge in the graph carries a single scalar:

```
struct EdgeAssociation {
    strength: f32,              // a_e ∈ [0, 1]
    last_used_secs: i64,        // optional, for slow decay
}
```

No `(S, D)`, no forgetting curve. Edge association tracks "how often does activation flow through
this connection during successful recall." It is a property of the _connection's reliability_, not
of the user's recall state.

### Why no forgetting curve on edges

FSRS's forgetting curve is empirically tuned to the dynamics of _item recall_ in human memory. Edge
association strength is a different kind of quantity — closer to ACT-R's `S_ji` associative weights,
which are updated by co-occurrence rather than time-based decay.

If two phrases are repeatedly recalled in succession, the edge between them is _real_ — its
association strength should remain high regardless of when it was last used. If they are _never_
recalled together, the edge should weaken — but slowly, over many failed observations, not via a
power-law decay clock.

This matches the ACT-R framing: chunk activations decay (FSRS-like); chunk-to-chunk associations are
learned from co-occurrence and persist unless contradicted (Hebbian-like).

### Hebbian update form

Several reasonable update forms; the one we adopt is a design choice.

**Option A — saturating linear:**

```
on success: a_e ← a_e + α · w_e · (1 - a_e)
on failure: a_e ← a_e - α · w_e · a_e
```

where `w_e` is the per-edge weight from the path posterior (see below). Saturating because the
multiplicative term `(1 - a_e)` shrinks updates as `a_e` approaches 1 (and similarly `a_e` near 0).
Naturally bounds `a_e ∈ [0, 1]` without hard clamps.

**Option B — log-odds (Bayesian flavour):**

Treat `a_e` as the parameter of a Bernoulli "edge fires successfully" distribution. Update its
log-odds:

```
λ_e := log(a_e / (1 - a_e))
on success: λ_e ← λ_e + α · w_e
on failure: λ_e ← λ_e - α · w_e
a_e ← σ(λ_e)
```

Equivalent to a stationary Bayesian update on a Beta-Bernoulli model with implicit prior counts
derived from `α`. Mathematically prettier, slightly heavier per-update.

**Option C — exponential moving average toward observation:**

```
target = posterior(success | this edge fired) ∈ {0, 1}   // discrete observation
a_e ← (1 - α · w_e) · a_e + (α · w_e) · target
```

Closer to "moving average of recent observed reliability." Simpler to reason about than Options A/B
but loses the bounded-rate-toward-extremes property.

**Recommended starting point:** Option A. Easy to reason about, well-bounded, small implementation
footprint. Reconsider after seeing simulation behaviour.

### Optional slow decay

Edge associations may decay slowly between updates if not used:

```
a_e ← a_e · exp(-λ_decay · (t_now - t_last_used) / TAU)
```

with `TAU` on the order of months and `λ_decay` small. Models the cognitive intuition that unused
connections eventually weaken, but on a much slower timescale than card-level forgetting.

This is optional and can be deferred.

## Path posterior at review time

The path posterior is intermediate computation in the single Bayesian update on edge associations
(see _Edge updates via Bayesian inference_). It is computed fresh at each review and not stored.
This section sets up the prior, likelihood, and posterior; the next section uses them to derive the
edge update.

### Path enumeration

For card `c`, enumerate all paths from its shown atoms to its hidden atoms, up to a hop limit. The
existing `path::enumerate_paths` machinery already does this. For a multi-hidden-atom card, paths
are enumerated per-hidden-atom and the per-atom posteriors handled separately (see _Multi-atom
cards_).

### Prior

Without observation, a path's probability under the current edge associations is:

```
P(π) ∝ R(π) = ∏_{e ∈ π} a_e
```

Normalize across `Π_c`:

```
P(π) = R(π) / Σ_{π' ∈ Π_c} R(π')
```

This prior says: "before observing the grade, the path most likely to have carried recall is the one
with the highest product of association strengths." Strong, short paths dominate; long or weak paths
get little prior weight.

### Likelihood

`P(g | π)` — given that the user actually used path `π`, what is the probability of observing grade
`g`? Adopted form (graded outcomes peaked at the path-strength they're most consistent with):

```
P(Again | π) ∝ (1 - R(π))²
P(Hard  | π) ∝ R(π) · (1 - R(π))
P(Good  | π) ∝ R(π)²
P(Easy  | π) ∝ R(π)^k       // with k ≥ 2; sharpens toward strongest paths
```

Each likelihood peaks at the path-strength most consistent with that grade:

* **Again** peaks at low `R` — failures are most likely on weak paths.
* **Hard** peaks at intermediate `R` ≈ 0.5 — effortful-but-successful recall most likely came
  through a path of middling strength.
* **Good** peaks at high `R` — clean success implies a strong path fired.
* **Easy** peaks at very high `R` — effortless recall implies a very strong path.

This is the cleanest closed-form likelihood with no free parameters beyond `k` for Easy. It captures
the empirical claim that a Hard grade is genuinely _informative_ about which path fired (not just an
alternative grading of the same path), which becomes important in the next section.

**Alternative likelihood forms considered and rejected:**

* _Bernoulli with Hard mapped to soft-success_ (`P(Hard | π) = R(π)`): treats Hard the same as Good
  for attribution, losing the information that effortful recall implies a not-fully-strong path.
  Simpler but loses signal.
* _Sigmoid threshold:_ `P(success | π) = σ(k · (R(π) - τ))` with parameters `τ, k`. Realistic but
  adds free parameters per likelihood with no obvious advantage over the closed-form bell-curve
  shapes above.
* _Multinomial logistic:_ `P(g | π) ∝ exp(β_g · R(π) + α_g)` with parameters fit per-grade. Most
  flexible, but requires data to fit and is hardest to reason about. Worth revisiting once user data
  exists.

### Posterior

By Bayes:

```
P(π | g) = P(g | π) · P(π) / Σ_{π' ∈ Π_c} P(g | π') · P(π')
```

This is normalised across `Π_c`. The path posterior is _not_ a separate semantic step; it appears as
an intermediate quantity when we compute the Bayesian update on edge associations (see below).

After observed success, the posterior concentrates on paths whose strength is consistent with
success. After observed failure, on paths whose strength is consistent with failure. After Hard, on
paths of intermediate strength. The posterior is asking "which path is most likely to have fired
given _both_ what we knew before and what we just observed?"

## Edge updates via Bayesian inference

There is one operation here, not two: **adjust each `a_e` given the observed grade, marginalising
over which path actually fired**. The path posterior `P(π | g)` from the previous section is
intermediate computation in this single update; it is not a separate "attribution" step.

### The single update we want

Treat each `a_e` as a parameter we're learning. The Bayesian update is:

```
prior:        current value of a_e
likelihood:   P(g | {a_e}) = Σ_π P(g | π) · P(π | {a_e})
posterior:    new a_e proportional to prior · likelihood
```

The likelihood marginalises over paths because we don't observe which path fired — only the grade.

### The gradient form

For a small step on `a_e`, the gradient of the log-posterior is what determines the update direction
and magnitude. By the standard EM identity:

```
∂/∂a_e  log P(g | {a_e})  =  E_{P(π | g, {a_e})} [ ∂/∂a_e log P(g, π | {a_e}) ]
```

i.e. the gradient is the path-posterior-weighted expectation of the per-path gradient. This is where
the path posterior `P(π | g)` enters: as a _weight_ in the gradient computation, not as a separate
computation we do for some other purpose.

For each edge `e`, the per-path gradient simplifies (under our chosen likelihood form):

```
∂/∂a_e log P(g, π | {a_e}) = (∂/∂a_e log R(π)) · (something depending on g and R(π))
                            = (1{e ∈ π} / a_e)  · (something depending on g and R(π))
```

The bracketed `something` reduces to a signed surprise-like quantity: positive for grades that are
"better than this path's R would predict", negative for grades that are "worse than this path's R
would predict". For our likelihood:

| Grade | Per-path gradient sign on `a_e` (for `e ∈ π`)                                |
| ----- | ---------------------------------------------------------------------------- |
| Easy  | strongly positive                                                            |
| Good  | positive                                                                     |
| Hard  | sign depends on `R(π)` — _negative_ if `R(π) > 0.5_, positive if`R(π) < 0.5` |
| Again | strongly negative                                                            |

This is the user-side intuition mathematically: **a Hard grade on a path the model thought was
strong (`R(π) > 0.5`) decrements that path's edges**, because the strong-path hypothesis predicts
Good or Easy — Hard is evidence against that path's strength estimate. Conversely, Hard on a path
the model thought was weak _reinforces_ those edges.

### Practical update rule

The exact gradient is well-defined but somewhat fiddly to compute and numerically delicate. The
following Hebbian-style approximation captures the same qualitative behaviour with simple closed
form:

```
expected_R = Σ_π P(π | {a_e}) · R(π)         // model's predicted recall strength for this card
observed_R = grade_to_score(g)                // {Easy: 1.0, Good: 0.85, Hard: 0.6, Again: 0.0}
surprise   = observed_R - expected_R          // signed; can be negative

post_e := Σ_{π : e ∈ π} P(π | g)              // marginal posterior that edge e was used

a_e ← a_e + α · post_e · surprise · saturate(a_e, sign(surprise))
```

where `saturate(a, +)` = `(1 - a)` and `saturate(a, -)` = `a`, keeping `a_e ∈ [0, 1]` without hard
clamps.

This rule has the right qualitative properties:

| Predicted      | Observed | Surprise  | Effect on high-posterior edges                          |
| -------------- | -------- | --------- | ------------------------------------------------------- |
| Strong (R≈0.9) | Easy     | +0.10     | Small reinforcement                                     |
| Strong         | Good     | -0.05     | Tiny correction (Good is barely below "perfect strong") |
| Strong         | **Hard** | **-0.30** | **Decrement** — model overestimated                     |
| Strong         | Again    | -0.90     | Strong decrement                                        |
| Weak (R≈0.3)   | Easy     | +0.70     | Strong reinforcement                                    |
| Weak           | Good     | +0.55     | Reinforcement                                           |
| Weak           | Hard     | +0.30     | Reinforcement (better than predicted)                   |
| Weak           | Again    | -0.30     | Decrement                                               |

The path posterior `P(π | g)` enters via `post_e` — edges only get updated to the extent they're
likely to have actually been used. Edges on paths the posterior says probably didn't fire get small
updates regardless of surprise.

### Why this is principled

After many reviews, the Hebbian-style update with surprise weighting converges toward the same fixed
point as the exact Bayesian update: `a_e` settles where its current value best predicts observed
grades for cards depending on edge `e`. Specifically, `a_e` converges toward the rate at which
recall flowing through `e` succeeds, which is exactly the cognitive content we want for a
graph-association strength.

The math is local — no joint posterior over all edges, no convergence loops. Each review's posterior
involves only `c`'s paths, computed in one pass, and the gradient (or its approximation) is applied
once per edge.

### Multi-atom cards

When `c` has multiple hidden atoms with separate grades, the posterior is computed per-atom and the
per-edge posteriors are summed across atoms. The update applies once per edge with the aggregated
weight. _Care needed:_ aggregated `post_e` across atoms can exceed 1 if an edge appears in paths to
many atoms — see the multi-atom section for handling.

## Card-to-card propagation

For each card `c'` other than `c`, compute a propagation weight from `c`'s review to `c'` based on
the path posterior. This admits multiple options.

### Option P1 — posterior-weighted edge alignment

For each path `π'` in `c'`'s path set, compute the fraction of its edges that have non-trivial
posterior weight from `c`'s review:

```
align(π', post) = Σ_{e ∈ π'} post_e / |π'|
```

Then:

```
prop(c → c') = Σ_{π' ∈ Π_{c'}} R(π') · align(π', post) / Σ_{π' ∈ Π_{c'}} R(π')
```

This is "the expected fraction of `c'`'s recall that flows through edges `c` actually used (per the
posterior), weighted by `c'`'s path probabilities."

`prop(c → c') ∈ [0, 1]`. A card `c'` whose dominant recall paths share many high-`post_e` edges with
`c` gets large propagation. A card whose recall flows through entirely different edges gets
near-zero propagation.

### Option P2 — KL divergence between posteriors

Compute `c'`'s prior (no observation) and `c'`'s posterior under `c`'s observation propagated
through edge associations. Take a divergence between them:

```
prop(c → c') = 1 - exp(-KL(P_prior(π' ∈ Π_{c'}) ‖ P_posterior(π' ∈ Π_{c'})))
```

Cards whose path distributions shift substantially under `c`'s observation get high propagation.
Cards whose distributions barely move get low propagation. More principled than P1 but requires a
second posterior computation per related card per review — substantially more expensive.

### Option P3 — Bayesian update on `c'`'s state directly

Treat `c`'s observation as evidence about the hidden recall reliability of edges shared with `c'`,
then propagate to `c'` via the FSRS update rule directly. This is closest to belief propagation but
local: no iteration, just one update step from the observed card to each neighbour.

### Applying the propagation

Whichever computation produces `prop(c → c')`, the update to `c'`'s state takes the same shape:

```
(S_{c'}, D_{c'}) ← FSRS_step_with_weight(S_{c'}, D_{c'}, t - t_{c'}, g, γ · prop(c → c'))
t_{c'} ← (1 - γ · prop(c → c')) · t_{c'} + (γ · prop(c → c')) · t
// last_root_secs unchanged
```

`γ` is a small global rate (e.g. 0.1–0.2) that controls how much propagation moves `c'` per
related-card review. Several propagated reviews accumulate; consistent signals from many directions
converge `c'`'s state toward the truth without ever directly observing `c'`.

### `FSRS_step_with_weight` — what does partial-strength mean for FSRS?

The standard FSRS step computes one full update. For propagation we want a fractional version. Two
natural definitions:

**Option W1 — interpolation in retrievability space (HSRS-style):**

```
1. Compute next state under full grade: (S', D') = FSRS_step(S, D, Δt, g)
2. Compute current and next retrievability at time t:
   R_now = R(S, D, Δt),  R_next = R(S', D', Δt)
3. Linearly interpolate retrievabilities:
   R_blend = (1 - w) · R_now + w · R_next
4. Solve for stability that produces R_blend at Δt:
   S_blend = invert_R(R_blend, Δt)
5. Linearly interpolate difficulty:
   D_blend = (1 - w) · D + w · D'
```

This is the math HSRS uses for its own probabilistic FSRS update. Bounded, geometrically sensible,
no spurious cancellations. Recommended.

**Option W2 — direct linear blend in stability/difficulty space:**

```
S ← S + w · (S' - S)
D ← D + w · (D' - D)
```

Simpler but reproduces the S1 cancellation pathology if multiple propagations with opposing grades
arrive on the same card before being flushed. Not recommended.

**Option W3 — accumulate weights, defer single update:**

Buffer all propagated updates received between direct reviews; aggregate them into one effective
grade-weight pair; apply Option W1 once at the next direct review. Avoids per-propagation
interpolation cost but delays the schedule effect.

**Recommended:** Option W1 applied immediately on each propagation. The math is HSRS-validated,
computational cost is modest, and the schedule stays current.

## Multi-atom cards

A card with multiple hidden atoms (e.g., full recitation with N phrases hidden) produces N grade
observations in one review. The path posterior extends naturally:

### Per-atom posteriors

For each hidden atom `h_k` in card `c`:

1. Enumerate paths from shown atoms to `h_k`: `Π_{c, k}`.
2. Compute per-atom prior `P(π | h_k)` from edge associations.
3. Compute per-atom likelihood `P(g_k | π)` using grade for atom `k`.
4. Compute per-atom posterior `P(π | g_k, h_k)`.
5. Compute per-atom marginal edge posterior `post_{e, k}`.

### Aggregating across atoms

Edge `e` may appear in paths to multiple atoms. Its total posterior weight from this review is:

```
post_e^total = Σ_k post_{e, k}
```

This can exceed 1.0 (an edge implicated in paths to many atoms). The question is whether to:

**Option AGG1 — let it accumulate:**

Use `post_e^total` directly as the Hebbian update weight. Hub edges participating in many atoms'
recall get correspondingly stronger updates per card. Justification: they did receive more evidence
from this review.

But this re-introduces a magnitude problem (similar in spirit to S2 in the audit). Hub edges'
associations move much faster than peripheral edges'.

**Option AGG2 — cap at 1.0:**

```
post_e^bounded = min(1.0, post_e^total)
```

Treat each card review as providing at most one update event's worth of evidence per edge,
regardless of how many atoms implicate the edge. Loses the "more atoms → more evidence" signal but
bounds the magnitude.

**Option AGG3 — average across atoms with non-trivial posterior:**

```
post_e^avg = post_e^total / |{k : post_{e, k} > ε}|
```

Average over only the atoms that meaningfully implicate the edge. Compromise between AGG1 and AGG2.

**Recommended starting point:** AGG2. Conservative, bounded, matches the "each card is one
observation" framing. Revisit if simulation suggests hub-edge associations are systematically
underestimated.

### Per-card propagation with multi-atom cards

Use the aggregated edge posterior `post_e^total` (or whichever variant) in the propagation
calculation. Related cards `c'` are weighted by overlap with the union of edges implicated across
atoms.

### Per-atom partial failures

If some atoms in a card pass and others fail, the per-atom posteriors naturally encode this: failed
atoms' posteriors concentrate on weak paths (blame), passed atoms' posteriors concentrate on strong
paths (credit). Aggregation treats them as separate observations on potentially overlapping edges.
The posterior framework absorbs partial failures without special-case logic.

## Verse-chunk layer (optional)

The verse-chunk layer adds holistic recitation tracking. It is additive to the core architecture and
can be deferred or omitted.

### Motivation

Most edges in verse-vault cannot be tested in isolation — gist nodes aren't displayable, hub edges
participate in many paths, ref-binding edges always involve their constituents. HSRS-style
ground-truth observations of individual edges are impossible.

But the _verse as a whole_ can be tested via full recitation. That observation is genuine ground
truth at the chunk level: did the user recite this verse correctly? It can anchor the system against
inferred-update drift.

### Per-direction chunk state

A "chunk" here is a (verse, retrieval direction) pair:

```
struct VerseChunkState {
    verse_ref: NodeId,
    direction: Direction,       // Forward, Reference, Completion
    stability: f32,
    difficulty: f32,
    last_recitation_secs: i64,
}
```

Where `Direction` distinguishes:

* _Forward:_ `ref → text` recitation.
* _Reference:_ `text → ref` attribution.
* _Completion:_ mid-verse continuation given a partial cue.

These are cognitively dissociable retrieval skills with different forgetting curves. Treating them
separately matches the empirical psychology (Tulving's encoding-specificity, asymmetric
paired-associate learning).

### Update: predict-vs-observe in retrievability space

When the user does a full recitation review (the chunk's "direct observation"):

1. **Predict the chunk's retrievability** under current constituent card states. Several aggregation
   rules:

   * _Product over spine:_ `R_chunk = ∏_{c ∈ spine} R_c(t)` (assumes independent failures of each
     link in the verse spine — recommended starting point).
   * _Minimum:_ `R_chunk = min_{c ∈ spine} R_c(t)` (weakest-link).
   * _Weighted product:_ weight each link by importance / position.

2. **Observe chunk retrievability from grade:**

   ```
   R_observed = { 0.0 if Again, 0.7 if Hard, 0.9 if Good, 1.0 if Easy }
   ```

   (Or, with per-phrase outcome data from the UI, derive `R_observed` from the proportion of phrases
   recalled correctly — much more informative.)

3. **Compute discrepancy:**
   ```
   ΔR = R_observed - R_chunk_predicted
   ```

4. **Apply chunk-level FSRS step** to the chunk's own state with grade `g_chunk`.

5. **Distribute the discrepancy across constituent edges** as a small nudge in retrievability space,
   weighted toward bottleneck edges:

   ```
   for each edge e in spine:
     R_e = R(a_e)              // approximate edge retrievability from association
     bottleneck_weight_e ∝ (1 - R_e)
     edge_ΔR_e = β · ΔR · bottleneck_weight_e (normalised)
     R_e_new = clamp(R_e + edge_ΔR_e, 0.001, 0.999)
     a_e ← invert_R(R_e_new)
   ```

   `β` small (0.05–0.15). Caps total per-recitation nudge magnitude.

### Cross-direction regularization

Reviewing one direction is _weak_ evidence for the others:

```
delta_main = full update on this direction's chunk
delta_cross = γ_cross · delta_main applied to other directions
```

with `γ_cross` small (0.05–0.10). Reflects shared underlying knowledge between forward / reference /
completion without claiming they're identical skills.

### Why edge-only vs chunk-only doesn't suffice

* _Edge-only:_ you cannot observe edges directly, so updates are always inferred. Drift can
  compound.
* _Chunk-only:_ you lose per-edge granularity for diagnostic and propagation purposes.
* _Combined:_ chunk observations anchor the system; per-edge associations carry diagnostic and
  propagation signal. They cross-check each other.

## Ground truth and drift prevention

In the original edge-FSRS architecture, the audit raised a concern that inferred-update drift could
accumulate without correction (S3 territory). Several mechanisms in this proposal address it:

### 1. Direct card observations

Cards are first-class state holders. Every direct review is a real observation of that card's
recall. `last_root_secs` tracks ground-truth events. Drift on a card cannot continue indefinitely —
the next direct review measures reality and the FSRS state update absorbs the discrepancy.

This is the same out-of-app-practice property FSRS itself has, which the edge-FSRS architecture
didn't have for edges (since edges can't be directly observed in isolation).

### 2. Hebbian convergence on edges

Edge associations updated by the path posterior have a clean probabilistic interpretation: `a_e`
converges toward the true success rate of recall flowing through edge `e`. Bayesian convergence
under reasonable assumptions: many noisy observations → posterior → truth.

No ground truth needed at the edge level — the law of large numbers does the work, _provided_ the
posterior is unbiased. The posterior is unbiased by construction (it's exact Bayesian inference on
the likelihood model), so the convergence holds.

### 3. Chunk-level ground truth

The optional verse-chunk layer provides direct holistic observations. Recitation events are real
ground truth at the verse level, independent of whether any individual edge was directly tested.
Chunk states regulate constituent edges via the retrievability-space nudge.

### 4. Scheduler bias toward stale ground truth

The scheduler can prefer cards with old `last_root_secs` even when propagation has been keeping
their state estimates fresh. This ensures each card receives periodic direct observations to anchor
against drift.

### Why this beats history-trace models

ACT-R-style history-trace models compute current state from a complete list of past observations.
They cannot recover from observation gaps (out-of-app practice) without explicit reconciliation
logic. This proposal — like FSRS — uses summary state plus Bayesian-flavoured updates, which absorb
observation discrepancies naturally.

The graph adds structure (which cards are related) without requiring a complete event history.

## Open questions

To answer iteratively as the architecture is prototyped:

1. ~~**Likelihood form for Hard grade.**~~ **Resolved.** The likelihood is
   `P(g | π) ∝ R(π)^a · (1 - R(π))^b` with `(a, b)` matched to the grade — Again at `(0, 2)`, Hard
   at `(1, 1)`, Good at `(2, 0)`, Easy at `(k, 0)` for `k ≥ 2`. Each grade peaks at the
   path-strength most consistent with that outcome. Crucially, the original "two steps" framing
   (path attribution then parameter update) was wrong — there is one Bayesian update on `a_e` that
   marginalises over paths; the path posterior is intermediate computation in that single update.
   Hard given a model-predicted-strong path automatically decrements that path's edges because the
   Hard observation is unlikely under the strong-path hypothesis. The surprise-based Hebbian rule
   (`Δa_e ∝ post_e · (observed_R - expected_R) · saturate`) is the practical approximation of the
   exact gradient. See _Edge updates via Bayesian inference_ for the derivation.

2. **Hebbian update form.** Options A/B/C above produce different convergence behaviour. Should be
   picked based on simulation sensitivity analysis once a prototype exists.

3. **Multi-atom aggregation.** AGG1/AGG2/AGG3 each have plausible justifications; the right choice
   depends on whether hub edges should experience disproportionately strong updates from
   full-recitation cards.

4. **Card-to-card propagation form.** P1 (posterior-weighted edge alignment) is recommended for
   simplicity; P2 (KL divergence) is more principled but expensive. Worth comparing on synthetic
   data before committing.

5. **Hyperparameter values.** `α` (Hebbian rate), `γ` (propagation rate), `β` (chunk influence),
   `γ_cross` (cross-direction), `λ_decay` (edge association decay). Need either hand-tuning against
   simulation or data-driven fitting.

6. **Should difficulty propagate?** HSRS says no — only direct reviews update D. This proposal
   currently inherits that. Worth revisiting whether soft propagation of difficulty makes sense for
   verse-vault's domain (where item-difficulty interpretation is hazier).

7. **Retrievability inversion stability.** Option W1 requires inverting the FSRS retrievability
   function. This is monotonic and well-defined but numerically delicate near the bounds. Need
   bounds checking wherever `invert_R` is called.

8. **Recitation grade granularity.** Should the chunk-level grade be a simple Again/Hard/Good/Easy,
   or per-phrase pass/fail (much more informative)? UI design choice with significant data-quality
   implications.

9. **Cold-start for new cards.** Initial card state and edge associations need defaults. FSRS
   already defines initial `(S, D)` per grade; for edges, a uniform `a_e = 0.5` is reasonable but
   could be refined (e.g., higher for structurally-mandatory edges like adjacency, lower for
   cross-verse anchor edges).

10. **Interaction with the discrimination / interleaving mechanism** (the InterferenceMap proposal).
    Confusion-pair cards generated from the InterferenceMap would have unusual path structure (cues
    from one verse, hidden atom from another). The path posterior for such cards needs to account
    for this — probably requires explicit modeling of the `Confusion` relation as a
    negative-correlation prior.

11. **Does the chunk layer pull its weight?** It adds complexity. Need to verify on simulation that
    holistic recitation observations measurably reduce drift relative to a card-only architecture.

12. **Is association decay needed at all?** The Hebbian update naturally moves associations toward
    observed reliability. Decay adds an additional pull toward zero for unused edges. Whether this
    is cognitively right or just produces unhelpful "all edges weaken over time" behaviour is
    unclear without simulation.

13. **Path enumeration cost.** Multi-atom cards with many shown atoms can produce many paths. The
    hop limit and path-count caps need to bound this without losing important paths. Existing
    `MAX_HOPS = 5` is probably fine but should be sanity-checked.

14. **What replaces anchor transfer?** Current anchor transfer scopes cross-verse paths to ref nodes
    in the same chapter with distance decay. Under the new architecture, this would be encoded as
    `Anchor` edge types (per the InterferenceMap) feeding into the path enumeration with appropriate
    prior weights. Whether the existing `decay_multiplier` semantics are preserved or refactored is
    open.

15. **Migration strategy** (out of scope for this doc but flagged): moving from edge-FSRS state to
    per-card FSRS + per-edge associations requires either re-initializing all state or deriving the
    new representation from existing state. Either way is a one-time cost.
