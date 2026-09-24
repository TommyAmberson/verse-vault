# Specification Quality Checklist: The Server Takes Every Event

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-23
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

Third draft. The first asked what lifecycle a client-side set-aside store should have, which was the
wrong question. The second moved the parking lot to the server but still let the server refuse
malformed events, which left a client able to hold work it could never hand over. This draft admits
no exceptions: the server takes everything, and disposition is applied, pending, or unusable.

Four gaps raised in review of the second draft, and how this one answers them:

- **"Well-formed" was load-bearing and undefined.** Removed as a concept. FR-001 has no exceptions,
  so nothing turns on the definition. Structurally broken events are taken and stored as unusable
  (see "What Malformed Means"), because the alternative asks a client to judge what is junk, and a
  client that judges wrong strands the work.
- **Nothing said what happens to a malformed event.** Now explicit, and SC-002 tests it.
- **FR-007 (re-applying a pending event) implied machinery nobody had costed.** Pinned to "whenever
  the account's state is next built", recorded in Assumptions, with the mechanism left to the plan.
- **The size limit was missing.** An outbox past the server's per-request cap was its own permanent
  dead end (#156). FR-013 folds it in, since it fails SC-001 the same way.

Decided rather than asked, all recorded in Assumptions: storing unusable events is worth the space;
pending events are reconsidered at state-build rather than by a background job; work recorded
against a since-disabled card type is history worth keeping.

Still open for `/speckit-plan`, deliberately: whether "applied" and "pending" need to be
distinguishable by the learner, or only by an operator. FR-010 requires the operator view; the
learner-facing half of the old US3 was cut because it is a product decision, not a correctness one.

## Fourth draft (revision after approval)

Review of the approved third draft found contradictions the checklist above had passed. All fixed in
the spec:

- **Stale-merge confirmation held work on the device.** FR-011 kept a step that took nothing until
  the learner answered, so an online device could not be wiped without loss while a question was
  open. Now the work is taken as pending, awaiting confirmation, and discard marks the server copy
  rather than deleting it.
- **A promoted pending event had no specified time.** FR-016: it counts at the time it was recorded.
  FR-017: promotion after a setting change does not re-ask the merge question.
- **FR-002 said three dispositions; FR-012 and the contract used four.** FR-002 now lists
  `duplicate`.
- **Deleting by reported disposition stranded an event the server could not name.** FR-005 now
  deletes everything an acknowledged upload carried.
- **FR-001 said "without exception" while the contract kept request-level refusals.** New section,
  "What Refusal Still Means", names the three that strand nothing. Not-enrolled is no longer one of
  them (FR-018).
- **FR-007 named a mechanism.** Now stated as an outcome: by the next time the learner opens the
  material.
- **SC-004 read as promising operator-free recovery of unusable data.** Scoped to recovering the
  device.

