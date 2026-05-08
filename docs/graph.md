# Verse index

How the core represents the static structure of the material being memorised. There is no graph in
the new architecture — the legacy `Graph` type and its edge taxonomy were removed in favour of a
flat per-verse element index plus HSRS state per test. For the memory model that sits on top of this
index, see [`path-posterior-memory-model.md`](path-posterior-memory-model.md). For the per-test
review pipeline see [`review.md`](review.md); for scheduling see [`scheduling.md`](scheduling.md).

## What replaced the graph

The old design carried FSRS state on edges of a multi-layer memory graph (phrase ↔ phrase, gist
hubs, ref bindings, club hierarchies, …) with credit assignment fanning out across paths. That
layered into structural problems (see `audit-fsrs6-2026-04-28.md`), and we chose Approach 2 of
`path-posterior-memory-model.md`: state lives on **tests**, and each test is attached to a single
concrete verse-scoped element.

The core therefore needs only two things at build time:

* the elements that exist for each verse, and
* a small bag of metadata (chapter numbers, book names, heading labels) that the renderer needs but
  the memory model itself does not.

Both live in `crates/core/src/verse_index.rs` and `crates/core/src/element.rs`.

## Elements

`ElementId` (`element.rs`) is the unit a `TestKey` attaches to:

```rust
pub enum ElementId {
    Phrase { verse_id, position },
    VerseRefPosition { verse_id },
    VerseChapterBinding { verse_id },
    VerseBookBinding { verse_id },
    VerseHeadingBinding { verse_id, heading_idx },
    VerseClubBinding { verse_id, tier },
}
```

Every element is verse-scoped; there are no chapter-, book-, heading-, or club-level identities of
their own (see _Why no chapter or book identities_ in the canonical spec). A binding like
`VerseChapterBinding { verse_id }` represents the question _"which chapter does this verse belong
to?"_ — it is a property of the verse, not a node in a hierarchy.

`ClubTier { Club150, Club300 }` is the only enum nested inside an element id; the tier-subset rule
(a 150 verse is implicitly also a 300 verse) is applied once at build time by
`builder::expand_tiers`.

## VerseIndex

```rust
pub struct VerseElements {
    pub phrases: Vec<u16>,         // phrase positions present
    pub headings: Vec<u16>,        // heading indices this verse falls under
    pub clubs: Vec<ClubTier>,      // club tiers this verse belongs to
}

pub struct VerseIndex { /* HashMap<verse_id, VerseElements> */ }
```

The index is built once from `MaterialData` and then read-only for the life of the engine. Three
accessors cover everything the rest of the core needs:

* `elements_of(verse_id) -> Option<&VerseElements>` — does this verse exist, and what are its parts?
* `phrases_of(verse_id) -> Vec<ElementId>` — phrase ids in position order.
* `bindings_of(verse_id) -> Vec<ElementId>` — every verse-binding element (ref, chapter, book, plus
  any headings and club tiers this verse has).

`bindings_of` is what composite cards reach for when they enumerate their contained tests: a
`Recitation` card grabs every phrase plus the verse-binding triple (ref position, chapter, book) so
the engine can decompose a single grade across them. The index does not store edges; cross-test
influence flows only through cards that explicitly contain multiple tests.

## ElementMeta

`ElementMeta` (also in `element.rs`) is a sidecar map keyed by `ElementId` that the engine carries
for renderers — chapter numbers, book names, heading labels, verse numbers. It is never read by the
FSRS or scheduling code; if you need to ask _"what's the actual chapter number this binding refers
to?"_ you look here. Treat it as opaque metadata.

## Where this fits

* `builder::build` → produces a `BuildResult` containing the `VerseIndex`, the `element_meta` map,
  the per-verse `VerseAtoms`, the cards, and seeded `TestState`s for every test the cards touch.
* `ReviewEngine` owns the `VerseIndex` and uses it to expand composite cards via `Card::tests` — the
  routing function that turns a `CardKind` into the set of `TestKey`s the engine should decompose a
  grade across.
* `Card`s are built once and never mutate after the build. Memory state lives in the per-test
  `TestState` map, not on cards or elements.

The index is intentionally small — adding a new layer (e.g. another club tier) means widening
`ClubTier` and `VerseElements::clubs`, not touching a graph schema or recomputing edge tables.
