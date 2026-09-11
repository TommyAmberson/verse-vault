# Feature Specification: Spelling Dialects for Rendered Scripture

**Feature Branch**: `chore/add-spec-kit` (retrofit; feature already shipped)

**Created**: 2026-09-11

**Status**: Draft — retrofit specification for shipped behaviour

**Input**: Retrofit spec for an already-implemented feature. Verse text is sourced in American
spelling and rendered in a configurable dialect. Document what exists and why, and surface the
decisions that were never written down.

## Context

This specification is written **after** the fact. The behaviour below ships today; the purpose here
is to state the intent it serves, fix the boundaries, and expose the choices that were made
implicitly. Where the current behaviour appears to be an accident rather than a decision, this spec
says so rather than ratifying it.

Scripture text reaches the product in American spelling, because the publisher and the delivery API
are both American. That is not in dispute — it is what the published edition says, and nothing here
claims the edition is wrong.

The feature exists because those spellings read as _mistakes_ to the people using this product.
`labor`, `armor`, `honor` — a Canadian reader does not experience these as a regional variant they
are broadly aware of, they experience them as misspelled words, and seeing a misspelling over and
over while deliberately committing text to memory is grating. That is the whole motivation. It is a
preference, not a measured usability problem, and this spec would rather say so than dress it up as
one.

## Licensing Constraints

The scripture text is not the project's to alter freely, and this shapes the feature more than the
reading experience does.

The NKJV is a copyrighted translation reached through a third-party API under terms the project does
not control. `NOTICE.md` displays the publisher's required attribution — that quotations "are taken
from the New King James Version®… Used by permission". Substitution puts that claim under strain:
text with changed spellings is not what the publisher printed, so presenting it under the version's
registered mark asserts something inaccurate.

Two consequences follow, and both are requirements rather than preferences.

**The published text is what the product ships.** Substitution is an opt-in a reader performs on
their own view, never the state a reader arrives in. This resolves what would otherwise be a direct
conflict: attribution is contractually required, and attributing altered text under the mark is the
problem. With the published text as the default the two requirements stop competing — the product
ships what it says it ships, and only a reader who chose otherwise sees otherwise.

**Alteration is disclosed wherever it happens.** A reader viewing modified text should be told the
text is modified, who modified it, and that it is not the published wording.

**Open, and not answerable from inside the project**: whether the licence permits this alteration at
all. Disclosure addresses the accuracy of the attribution; it does not grant permission. The
governing terms are the API account's licence agreement and, beyond what that covers, the
publisher's permissions department — neither of which is public. This spec therefore treats
disclosure and an unmodified default as the floor, not as a resolution. If the answer comes back no,
the feature needs rethinking rather than adjusting.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Reader sees scripture in their own dialect (Priority: P1)

A quizzer opens a verse to memorise. The words are spelled the way they spell them, so nothing on
the page looks wrong to them.

**Why this priority**: This is the entire point of the feature — there is nothing else to it. The
product works fine without it; it just irritates its readers a little on every screen, in the one
activity where they are staring hardest at the words.

**Independent Test**: Configure the product for a non-source dialect, open any verse containing a
word with a known dialect variant, and confirm the rendered text shows the reader's form.

**Acceptance Scenarios**:

1. **Given** the product is configured for Canadian spelling, **When** a reader opens a verse
   containing "labor", **Then** the rendered text reads "labour".
2. **Given** the product is configured for British spelling, **When** a reader opens a verse
   containing "realize", **Then** the rendered text reads "realise".
3. **Given** the product is configured for Canadian spelling, **When** a reader opens a verse
   containing "realize", **Then** the rendered text still reads "realize", because Canadian usage
   keeps that form.

---

### User Story 2 - Reader chooses their own dialect (Priority: P2)

A reader picks the spelling they want and it sticks, independently of what any other reader on the
same deployment has chosen.

**Why this priority**: Spelling preference is personal, not operational. Two quizzers sharing a
deployment can want different dialects, and neither should have to accept the other's. This ranks
below the reading experience only because a sensible default already serves most readers.

**Not yet built.** The dialect is currently a single deployment-wide setting. This story states the
intent; see Assumptions for the gap.

**Independent Test**: Set two readers to different dialects on the same deployment and confirm each
sees their own spelling in the same verse.

**Acceptance Scenarios**:

1. **Given** two readers with different dialect preferences, **When** both open the same verse,
   **Then** each sees their own dialect's spelling.
2. **Given** a reader changes their dialect preference, **When** they next open a verse, **Then**
   the new dialect applies without affecting any other reader.
3. **Given** a reader has expressed no preference, **When** they open a verse, **Then** the
   deployment's default dialect applies.

---

### User Story 3 - The published text is what arrives by default (Priority: P3)

A reader who has chosen nothing sees exactly what the publisher printed, and can return to it at any
time.

**Why this priority**: Ranked last as a _journey_ because it is the path where nothing happens — but
it is not optional. It is what keeps the product's attribution honest, and it is the state every
reader starts in. See Licensing Constraints.

**Acceptance Scenarios**:

1. **Given** a reader who has expressed no dialect preference, **When** any verse is rendered for
   them, **Then** the text is byte-identical to what the content source supplied.
2. **Given** a reader who has selected the source dialect explicitly, **When** any verse is rendered
   for them, **Then** the text is byte-identical to what the content source supplied.
3. **Given** a reader viewing unmodified text, **When** they read the attribution, **Then** it
   carries no modification notice, because nothing was modified.

### Edge Cases

* **Capitalisation.** A variant word may appear lowercase, sentence-initial, or fully capitalised.
  All three must survive substitution in the reader's expected form — `labor`, `Labor`, and `LABOR`
  become `labour`, `Labour`, and `LABOUR`. Fully-capitalised words matter more here than in most
  text: scripture renders divine names in small caps or full caps.
* **Markup.** Rendered verse text carries formatting markup. Substitution must not corrupt it, and
  must not match words inside markup rather than inside the text.
* **Multi-word variants.** Some dialect differences are phrases rather than single words. These are
  out of scope — see Assumptions.
* **Words with no variant.** The overwhelming majority of words have no dialect difference and must
  pass through unchanged.
* **Proper nouns and transliterated names.** Scripture is dense with names that must never be
  altered by a general-purpose dictionary.
* **Unknown dialect configuration.** Covered in User Story 2.

## Requirements _(mandatory)_

### Functional Requirements

* **FR-001**: The product MUST render verse text in one of three dialects: the source dialect and
  two target dialects.
* **FR-002**: When configured for the source dialect, the product MUST perform no substitution and
  return the content source's text unchanged.
* **FR-003**: Substitution MUST preserve the capitalisation of the word it replaces — fully
  capitalised, initially capitalised, and lowercase forms each render in the corresponding form.
* **FR-004**: Substitution MUST NOT alter formatting markup in rendered verse text, and MUST NOT
  match text inside markup.
* **FR-005**: Substitution MUST be confined to whole words. A variant MUST NOT be applied to a
  substring of a longer word.
* **FR-006**: Substitution MUST NOT apply to multi-word variants.
* **FR-007**: The configured dialect MUST apply consistently to every rendered verse the reader can
  reach, so the same word never appears in two spellings across different parts of the product.
* **FR-008**: Each reader MUST be able to select their own dialect, and that selection MUST apply
  only to what they see.
* **FR-009**: The default dialect MUST be the source dialect. A reader who has expressed no
  preference MUST be shown the publisher's text unaltered. Substitution is always something a reader
  opts into, never a state they arrive in.
* **FR-014**: Whenever a reader is shown substituted text, the product MUST disclose it alongside
  the scripture attribution. The disclosure MUST name the dialect applied, attribute the change to
  the product rather than to the publisher, and state that the text shown is not the published
  wording.
* **FR-015**: The disclosure MUST NOT appear when no substitution is in effect, so that a reader on
  the source dialect sees the publisher's attribution exactly as required and nothing more.
* **FR-016**: The disclosure MUST follow the reader whose view it describes. With per-reader
  dialects, two readers on one deployment may need different disclosures for the same verse.
* **FR-010**: An unrecognised dialect value, from either source, MUST resolve to the default rather
  than failing to start or rendering inconsistently.
* **FR-011**: The dialect vocabulary MUST come from a maintained external source rather than a
  hand-curated word list, so that dialect coverage improves without project-side editing.
* **FR-012**: Substitution MAY change the spelling a reader memorises, and that is acceptable.
  Competition is verbal, so a re-spelled text cannot cost a quizzer marks — spelling is never
  examined. No dialect-aware suppression is required for competition material.
* **FR-013**: Where the product compares a reader's typed recitation against expected text, both
  sides MUST be in the same dialect. A reader who types exactly what they were shown MUST NOT be
  marked wrong because the comparison's canonical side was drawn from un-substituted source text.

### Key Entities

* **Dialect**: The spelling convention applied to rendered verse text. Three values: the source
  dialect (no substitution) and two target dialects.
* **Variant mapping**: The correspondence between a source-dialect word and its form in a target
  dialect. Supplied by an external, maintained vocabulary rather than authored in this project.
* **Rendered verse text**: The formatted scripture a reader sees. The only surface substitution
  applies to.

## Success Criteria _(mandatory)_

### Measurable Outcomes

* **SC-001**: For any verse rendered in a target dialect, every word covered by the variant
  vocabulary appears in that dialect's form, and no other word in the verse differs from the source
  text.
* **SC-002**: Rendering a verse in the source dialect produces output identical to the content
  source's text, with zero differences.
* **SC-003**: Capitalisation is preserved in 100% of substitutions, verified across lowercase,
  initial-capital, and fully-capitalised inputs.
* **SC-004**: Formatting markup in rendered output is unchanged by substitution in 100% of cases.
* **SC-005**: A reader moving between any two parts of the product that display the same verse sees
  the same spelling in both.
* **SC-006**: Two readers with different preferences, viewing the same verse on the same deployment
  at the same time, each see their own dialect.
* **SC-007**: Changing a dialect preference requires no content edits and leaves stored reader
  progress untouched.
* **SC-008**: A reader who types the displayed text verbatim is never marked wrong on account of
  dialect, in any dialect, on any surface that compares typed input against expected text.
* **SC-009**: A reader who has chosen nothing sees text identical to the content source, with zero
  differences, on every surface.
* **SC-010**: Every surface showing substituted text also shows the modification disclosure; no
  surface shows substituted text under the unqualified publisher attribution.

## Assumptions

These were reasonable defaults or inherited constraints rather than deliberate decisions. Each is a
candidate for revisiting.

* **Dialect is deployment-wide today, and that is a shortfall, not a design.** The intended scope is
  per-reader (FR-008). The current single deployment-wide setting was a punt taken to ship the
  substitution itself, and it happens to be adequate because the only deployment has one dialect's
  worth of readers. Any work on this feature should close that gap rather than build on the
  deployment-wide assumption.
* **The shipped default contradicts FR-009, and this spec does not ratify it.** Today the default is
  a substituting dialect, so the out-of-the-box experience shows altered text under the publisher's
  unqualified attribution. FR-009 requires the opposite. This is the one place where the spec
  knowingly describes behaviour the product does not yet have, because the current behaviour is the
  weaker position to defend and matching the spec to it would entrench that.
* **No modification disclosure exists yet.** FR-014 through FR-016 describe behaviour to be built.
  The attribution currently shown is the publisher's alone, with nothing indicating substitution.
* **The source text is American-spelled.** This follows from the publisher and the delivery API, not
  from a project choice. If the content source ever changes, the "no substitution" dialect stops
  being a no-op and this spec's framing needs revisiting.
* **The variant vocabulary's judgement is accepted wholesale.** The project makes no per-word
  decisions about what Canadian or British spelling _is_ — it takes an external vocabulary's word
  for it. So the observation that Canadian keeps American `-ize` verbs and `-or` agent nouns while
  taking British `-our`, `-ence` and `-re` is a _description of that vocabulary_, not a rule this
  project authored or can defend independently. Disagreeing with a specific word means disagreeing
  with the upstream source.
* **Multi-word variants are out of scope.** Excluded because whole-word matching cannot express
  them, which is an implementation constraint that became a scope boundary. Nobody decided phrases
  do not matter.
* **Substitution reaches answer checking, and is not purely display-only.** The product does compare
  typed recitation against expected text, so the dialect a reader was shown and the dialect the
  comparison uses have to agree. Today both are expected to derive from the same rendered payload,
  which makes the invariant hold by construction rather than by design — nothing enforces it. FR-013
  states it explicitly so it survives any future change that sources canonical text separately.
  Per-reader dialects sharpen this: the same verse is graded against two different spellings
  depending on who is reading.
* **Spelling is never examined.** Competition is verbal, so the product carries no obligation to the
  published edition's orthography. This is what makes substitution safe at all; if a written
  examination format ever appeared, FR-012 would have to be reopened.
* **Proper nouns are safe by coincidence.** No name-protection mechanism exists; correctness relies
  on the external vocabulary not containing scripture proper nouns. This holds today but is not
  guaranteed by anything.
* **Substitution cost is negligible.** The feature assumes dialect application is cheap enough to
  run on every render without caching concerns.
