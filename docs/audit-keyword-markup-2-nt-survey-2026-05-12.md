# Keyword markup triage — NT Survey (year 2-NT)

Cross-checks three sources for every word in the year's material:

1. **Rule** — computed from canonical NKJV: a word in exactly one verse is a keyword (bold); a word
   in 2+ verses within a 5-verse window in the same book is a context-key (bold-italic).
2. **Back-list** — the printed keyword list in the back of the quizbook (lists keywords only; says
   nothing about context-keys).
3. **Anki deck** — the user's annotations imported from the colpkg.

Categories (same as the year-3 audit doc):

* **Type 3 (BOOK BODY)** — book formatting agrees with the deck (both disagree with the rule). Book
  is the source of truth for Anki, so no Anki fix is needed.
* **Type 4 (ANKI TYPE)** — book formatting agrees with the rule and disagrees with the deck. Fix the
  Anki annotation.

## Status (2026-05-12)

**Verse text Type-4 errors: 0.** As of the 14:35:32 colpkg export the deck's verse text, FTV counts,
and FTV cue content all match the printed quizbook. Four residual text discrepancies vs standard
NKJV are Type-3 (book typography differs from biblegateway/api.bible's NKJV — see commit `0f28234`'s
message).

**Keyword markup remains the open question.** `tools/find_keywords.py` flagged 52 unique words
against the Anki-derived annotations, expanding to **78** per-verse actions:

* under-marked: **54** — rule wants markup the deck didn't have
* over-marked: **0** — deck has markup the rule doesn't want
* wrong-kind: **24** — rule and deck disagree on the kind

`tools/apply_audit.py` applied all candidates the same day, bringing the deck into rule-alignment
(re-audit returns 0). Hand-triage classifying each candidate as Type 3 (book-body) vs Type 4 (Anki
typo) is **pending** — the list below is the raw report, unclassified.

## Type 4 — to fix in Anki

_TODO: hand-triage against the printed book. Move candidates from the Type 3 list below as they're
confirmed as Anki authoring errors._

## Type 3 — book formatting issues (candidates pending triage)

Listed by book then chapter. Each entry is `verse:word — action` where the action is what the rule
requires of the deck.

### 1 John

* 2:22 `denies` — add bold-italic (context-key)
* 2:23 `denies` — add bold-italic (context-key)

### 1 Timothy

* 4:7 `fables` — add bold (keyword)
* 4:8 `bodily` — add bold (keyword)
* 4:8 `profits` — add bold (keyword)

### 2 Timothy

* 3:2 `lovers` — add bold-italic (context-key)
* 3:4 `lovers` — add bold-italic (context-key)
* 3:11 `persecutions` — change bold-italic → bold
* 3:14 `learned` — change bold-italic → bold

### Acts

* 1:12 `journey` — add bold (keyword)
* 1:20 `it'` — add bold (keyword)

* 2:19 `vapor` — add bold (keyword)
* 2:47 `favor` — add bold (keyword)

* 12:20 `king's` — change bold-italic → bold

* 15:16 `rebuild` — change bold-italic → bold

### Matthew

* 2:18 `weeping` — change bold-italic → bold

* 4:21 `zebedee` — change bold-italic → bold

* 5:13 `flavor` — add bold (keyword)
* 5:13 `salt` — change bold-italic → bold
* 5:21 `danger` — add bold-italic (context-key)
* 5:22 `danger` — add bold-italic (context-key)
* 5:25 `adversary` — change bold-italic → bold
* 5:27 `adultery` — add bold-italic (context-key)
* 5:28 `adultery` — add bold-italic (context-key)
* 5:29 `perish` — change bold → bold-italic
* 5:32 `adultery` — add bold-italic (context-key)
* 5:33 `swear` — add bold-italic (context-key)
* 5:34 `swear` — add bold-italic (context-key)
* 5:36 `swear` — add bold-italic (context-key)
* 5:37 `yes'` — add bold (keyword)
* 5:38 `tooth` — change bold-italic → bold
* 5:43 `neighbor` — add bold (keyword)
* 5:46 `collectors` — change bold → bold-italic
* 5:46 `tax` — change bold → bold-italic
* 5:47 `collectors` — change bold → bold-italic
* 5:47 `tax` — change bold → bold-italic

* 6:1 `charitable` — add bold-italic (context-key)
* 6:2 `charitable` — add bold-italic (context-key)
* 6:3 `charitable` — add bold-italic (context-key)
* 6:4 `charitable` — add bold-italic (context-key)
* 6:14 `trespasses` — add bold-italic (context-key)
* 6:15 `trespasses` — add bold-italic (context-key)
* 6:30 `tomorrow` — add bold-italic (context-key)
* 6:34 `tomorrow` — add bold-italic (context-key)

* 7:3 `plank` — add bold-italic (context-key)
* 7:3 `speck` — add bold-italic (context-key)
* 7:4 `eye'` — add bold (keyword)
* 7:4 `plank` — add bold-italic (context-key)
* 7:4 `remove` — add bold-italic (context-key)
* 7:4 `speck` — add bold-italic (context-key)
* 7:5 `plank` — add bold-italic (context-key)
* 7:5 `remove` — add bold-italic (context-key)
* 7:5 `speck` — add bold-italic (context-key)
* 7:25 `blew` — add bold-italic (context-key)
* 7:27 `blew` — add bold-italic (context-key)

* 27:9 `priced` — change bold-italic → bold
* 27:35 `garments` — change bold-italic → bold
* 27:46 `eli` — change bold-italic → bold

### Revelation

* 4:3 `appearance` — change bold-italic → bold

* 5:11 `ten` — change bold-italic → bold
* 5:11 `thousands` — change bold-italic → bold

* 6:6 `denarius` — change bold-italic → bold

* 19:1 `alleluia` — add bold-italic (context-key)
* 19:2 `judgments` — add bold (keyword)
* 19:3 `alleluia` — add bold-italic (context-key)
* 19:4 `alleluia` — add bold-italic (context-key)
* 19:6 `alleluia` — add bold-italic (context-key)
* 19:20 `image` — add bold-italic (context-key)

* 20:1 `pit` — add bold-italic (context-key)
* 20:3 `pit` — add bold-italic (context-key)
* 20:4 `image` — add bold-italic (context-key)
* 20:12 `books` — change bold-italic → bold

* 21:16 `length` — change bold-italic → bold
* 21:17 `cubits` — add bold (keyword)

* 22:11 `filthy` — change bold-italic → bold

### Titus

* 2:3 `behavior` — add bold (keyword)
* 2:7 `showing` — add bold-italic (context-key)
* 2:10 `showing` — add bold-italic (context-key)
