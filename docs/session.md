# Sessions

How within-session flow works: re-drills after lapses, progressive reveal for new verses. Depends on
the graph ([graph.md](graph.md)), review model ([review.md](review.md)), and scheduling
([scheduling.md](scheduling.md)).

## Design principle

The session is a **queue manager, not a memory tracker**. All memory state lives on edges (tracked
by FSRS). The session decides what card to show next and when to insert re-drills. All reviews flow
through the ReviewEngine — no separate session-local stability.

## Session flow

1. Build a queue from due cards (by priority) + new verse introductions
2. Present cards one at a time
3. After each review: credit assignment updates edges, cascade updates card schedules
4. If any atom is graded Again: insert re-drill cards into the queue
5. Session ends when the queue is empty

## Re-drill cards

Re-drill cards are **transient** — constructed on the fly, not persisted to the card catalog. When
an atom fails during a review, the session creates a targeted card:

| Condition                   | Re-drill type                 |
| --------------------------- | ----------------------------- |
| 1 atom failed               | Fill-in-blank for that atom   |
| 2+ failed, ≤ half of hidden | Fill-in-blank per failed atom |
| > half of hidden failed     | Full recitation               |

Re-drills are inserted near the front of the queue (after 1-2 other cards for spacing). The FSRS
short-term formula (w17-w19) handles same-day review scheduling naturally.

After a re-drill succeeds, the edges on paths to the re-drilled atom have been updated by normal
credit assignment. If effective_R is still below target, the session can insert another re-drill. No
special tracking — the edge state IS the tracking.

## Progressive reveal (new verses)

When introducing a new verse, the session creates a sequence of cards:

1. **Reading**: show reference + all phrases. No grading. Learner reads the verse.
2. **Fill-in-blank per phrase**: test each phrase individually, in position order. If a phrase fails
   → insert re-drill, don't advance until it passes.
3. **Full recitation**: show reference, hide all phrases. Tests the complete chain. If any phrase
   fails → insert re-drills, then retry full recitation.
4. **Done**: all reviews flow through ReviewEngine, edges have initial FSRS state.

All reviews (including progressive reveal) use the same credit assignment algorithm. No special
handling — the progressive reveal is just a sequence of cards in the queue.

## Re-drill card construction

A re-drill needs to know the verse context: which reference and which phrases. The graph provides
this via `verse_context(atom)` — traverses from the atom to its VerseGist hub, then collects the
VerseRef and all Phrases (sorted by position).

Fill-in-blank: `shown = {ref, all other phrases}`, `hidden = {failed phrase}` Full recitation:
`shown = {ref}`, `hidden = {all phrases}`

## Session parameters

| Parameter                      | Default | Meaning                                                     |
| ------------------------------ | ------- | ----------------------------------------------------------- |
| max_session_size               | 20      | Maximum cards in a session                                  |
| max_new_verses                 | 3       | New verses introduced per session                           |
| fail_ratio_for_full_recitation | 0.5     | If > 50% of hidden atoms fail, use full recitation re-drill |

## FSRS parameters

Default FSRS parameters are used. The user's Anki parameters are calibrated for whole-verse cards
(reflecting Woźniak memory complexity). Edge-level phrase transitions are simpler memory units and
should have higher initial stabilities closer to defaults. Per-user parameter optimization is
planned for later.
