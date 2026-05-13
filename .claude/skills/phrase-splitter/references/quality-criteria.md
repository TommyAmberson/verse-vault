# Phrase-split quality criteria

A phrase is a unit a reciter holds in working memory while saying the verse from memory. The split
should feel like natural pauses — where a careful reader would breathe.

## Guiding principle

**Keep splits small, but completeness of thought matters more than size.** Every phrase should be a
self-contained unit of meaning. A 9-word phrase that finishes a thought is better than 4 + 5 that
severs it. When in doubt between a shorter awkward split and a longer natural one, choose the
natural one. All the rules below are in service of this principle, not above it.

## Hard rules (deterministic checks enforce these)

* **Rejoin invariant.** `" ".join(phrases) == text` — exact match including HTML tags, punctuation,
  and quotation marks. If a split doesn't round-trip, it's wrong.
* **Phrase length: target 3–10 words.** 12 is the soft warning ceiling that the auditor surfaces for
  review. There is no validator cap: a phrase can exceed 12 when a clause is genuinely continuous
  and has no natural internal breakpoint (e.g.
  `"that his spirit may be saved in the day of the Lord Jesus."`). The lower bound allows 1+ to
  admit short trailing closures like `"and Him crucified."`. Prefer naturalness over hitting the
  target.
* **HTML tag balance.** Every `<b>`, `<i>`, `<span ...>` open must close inside the same phrase.
  Never split inside a tag.

## Soft rules (where most quality problems hide)

* **No stranded short fragments mid-verse.** `"But one"` followed by the rest of the verse is the
  classic bad break. If a 1–2 word phrase sits between two longer ones, it almost always belongs
  glued to the next.
* **Honour parallel structure.** `"not many wise / not many mighty / not many noble"` should be
  three sibling phrases, not lumped into one or arbitrarily merged.
* **Break at clause boundaries.** Strong cues:
  * after a comma, semicolon, or colon
  * before a connector that starts a new thought: `and`, `but`, `for`, `that`, `who`, `which`, `or`
    — only when it really begins a new clause, not when it just glues list items
* **Never split a verb from its content clause.** `that` (and `what`, `how`, `whether`, `if`) after
  a verb of perception or speech — `know`, `see`, `tell`, `say`, `believe`, `think`, `hear`,
  `understand`, `remember`, `perceive` — is introducing the _object_ of the verb, not a new clause
  for recitation. `"Do you not know"` / `"that we shall judge angels?"` is a bad break; the
  rhetorical question is one unit. Same for `"I declare to you"` /
  `"that flesh and blood cannot inherit..."`. The auditor flags this pattern automatically
  (`verb-clause-split`).
* **Keep rhetorical questions whole.** A question stem (`"Do you not know that..."`,
  `"Are you not aware that..."`) belongs with its content. Split _after_ the question mark, not
  inside it.
* **Don't lop-side.** A verse split into one 15-word phrase and one 3-word phrase is worse than two
  9-word phrases. Aim for relatively even chunks while still respecting clause boundaries.
* **Single-phrase verses.** Anything over ~10 words should split somewhere. Anything under ~8 can
  stay whole.

## Edge cases that are usually fine

* A single-word opener like `"Moreover,"` or `"Therefore,"` at position 0. Stylistic, often
  deliberate in memorisation aids. Flagged `medium` by the evaluator, not `high`.
* A short final phrase like `"are called."` or `"and Him crucified."` that carries closing
  punctuation. Same treatment — `medium`, not blocking.
* A pair of short intro phrases like `"Therefore," / "my beloved,"`. Often the natural break is to
  merge them into one `"Therefore, my beloved,"` phrase, but both forms are defensible — the
  evaluator will surface this as `high` (middle 2-word phrase) for human review.

## Worked examples

### Long clause that needs a break

Bad:

```
["For you see your calling, brethren, that not many wise according to the flesh,",
 "not many mighty, not many <b>noble</b>,",
 "are called."]
```

Phrase 1 is 14 words. Split it on the comma after `brethren,`:

```
["For you see your calling, brethren,",
 "that not many wise according to the flesh,",
 "not many mighty, not many <b>noble</b>,",
 "are called."]
```

### Stranded fragment

Bad (1 Cor 12:11):

```
["But one",
 "and the same Spirit works all these things,",
 "<b>distributing</b> to each one individually as He wills."]
```

`"But one"` belongs glued to the same-Spirit clause; the natural break is after the comma:

```
["But one and the same Spirit works all these things,",
 "<b>distributing</b> to each one individually as He wills."]
```

### Parallel structure

Verse:

```
For you see your calling, brethren, that not many wise according to the flesh, not many mighty, not many <b>noble</b>, are called.
```

Good split: each parallel `"not many …"` item gets its own phrase rather than being lumped together.

### Whole-verse short verse

`"For the kingdom of God is not in word but in power."` — 10 words and one self-contained idea. One
phrase is correct; forcing a break would weaken the unit.

### HTML markup

`"<b><i>asking</i></b>"` is one word, one indivisible unit. A split that strips or rewrites the
markup fails the rejoin invariant and the HTML- balance check. Always preserve markup byte-for-byte.
