# Keyword markup triage — GEPC — Galatians, Ephesians, Philippians, Colossians (year 1-GEPC)

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

`tools/find_keywords.py` flagged 66 unique words against the Anki-derived annotations, expanding to
**78** per-verse actions:

* under-marked: **41** — rule wants markup the deck didn't have
* over-marked: **0** — deck has markup the rule doesn't want
* wrong-kind: **37** — rule and deck disagree on the kind

`tools/apply_audit.py` applied all candidates the same day, bringing the deck into rule-alignment
(re-audit returns 0). Hand-triage classifying each candidate as Type 3 (book-body) vs Type 4 (Anki
typo) is **pending** — the list below is the raw report, unclassified.

## Type 4 — to fix in Anki

_TODO: hand-triage against the printed book. Move candidates from the Type 3 list below as they're
confirmed as Anki authoring errors._

## Type 3 — book formatting issues (candidates pending triage)

Listed by book then chapter. Each entry is `verse:word — action` where the action is what the rule
requires of the deck.

### Colossians

* 1:2 `colosse` — add bold (keyword)

* 2:2 `attaining` — change bold-italic → bold
* 2:23 `religion` — add bold (keyword)

* 3:13 `must` — change bold-italic → bold

* 4:9 `happening` — add bold (keyword)
* 4:9 `here` — add bold (keyword)
* 4:12 `laboring` — add bold (keyword)
* 4:16 `epistle` — change bold-italic → bold

### Ephesians

* 2:15 `contained` — change bold-italic → bold
* 2:15 `thus` — change bold-italic → bold

* 4:8 `ascended` — add bold-italic (context-key)
* 4:8 `captive` — add bold (keyword)
* 4:8 `captivity` — change bold-italic → bold
* 4:8 `gifts` — change bold-italic → bold
* 4:8 `high` — change bold-italic → bold
* 4:9 `ascended` — add bold-italic (context-key)
* 4:10 `ascended` — add bold-italic (context-key)
* 4:26 `angry` — change bold-italic → bold
* 4:28 `steal` — add bold (keyword)
* 4:31 `clamor` — add bold (keyword)

* 5:1 `thereforebe` — add bold (keyword)
* 5:5 `idolater` — add bold (keyword)
* 5:28 `loves` — change bold-italic → bold
* 5:31 `leave` — change bold-italic → bold

* 6:2 `honor` — add bold (keyword)
* 6:11 `armor` — add bold-italic (context-key)
* 6:12 `hosts` — change bold-italic → bold
* 6:13 `armor` — add bold-italic (context-key)

### Galatians

* 1:15 `womb` — add bold (keyword)

* 2:4 `occurred` — change bold-italic → bold
* 2:6 `favoritism` — add bold (keyword)
* 2:6 `seemed` — add bold-italic (context-key)
* 2:8 `effectively` — change bold-italic → bold
* 2:9 `seemed` — add bold-italic (context-key)
* 2:13 `jews` — add bold-italic (context-key)
* 2:14 `jews` — add bold-italic (context-key)
* 2:15 `jews` — add bold-italic (context-key)

* 3:6 `accounted` — change bold-italic → bold
* 3:8 `nations` — change bold-italic → bold
* 3:8 `saying` — change bold-italic → bold
* 3:10 `curse` — add bold-italic (context-key)
* 3:13 `curse` — add bold-italic (context-key)
* 3:13 `hangs` — change bold-italic → bold
* 3:13 `tree` — change bold-italic → bold
* 3:15 `man's` — add bold (keyword)
* 3:20 `mediate` — change bold-italic → bold
* 3:23 `kept` — change bold-italic → bold

* 4:15 `enjoyed` — change bold-italic → bold
* 4:24 `sinai` — change bold → bold-italic
* 4:27 `barren` — change bold-italic → bold
* 4:27 `break` — change bold-italic → bold
* 4:27 `desolate` — change bold-italic → bold
* 4:27 `shout` — change bold-italic → bold
* 4:30 `cast` — change bold-italic → bold

* 5:4 `attempt` — change bold-italic → bold
* 5:13 `use` — change bold-italic → bold

* 6:7 `reap` — add bold-italic (context-key)
* 6:7 `sows` — add bold-italic (context-key)
* 6:8 `reap` — add bold-italic (context-key)
* 6:8 `sows` — add bold-italic (context-key)
* 6:9 `reap` — add bold-italic (context-key)

### Philippians

* 1:3 `thank` — add bold (keyword)
* 1:12 `furtherance` — add bold (keyword)
* 1:12 `happened` — change bold-italic → bold
* 1:23 `between` — add bold (keyword)

* 2:4 `interests` — change bold-italic → bold
* 2:8 `point` — change bold-italic → bold
* 2:27 `almost` — add bold (keyword)
* 2:27 `sorrow` — change bold-italic → bold
* 2:27 `unto` — add bold (keyword)

* 3:7 `loss` — add bold-italic (context-key)
* 3:8 `count` — add bold-italic (context-key)
* 3:8 `loss` — add bold-italic (context-key)
* 3:13 `count` — add bold-italic (context-key)
* 3:16 `degree` — change bold-italic → bold

* 4:2 `implore` — change bold-italic → bold
* 4:2 `syntyche` — add bold (keyword)
* 4:16 `aid` — change bold-italic → bold
