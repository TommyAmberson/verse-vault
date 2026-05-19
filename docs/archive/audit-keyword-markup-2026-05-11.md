# Keyword markup triage — 1 & 2 Corinthians (year 3-C)

Cross-checks three sources for every word in 1+2 Cor:

1. **Rule** — computed from canonical NKJV: a word in exactly one verse is a keyword (bold); a word
   in 2+ verses within a 5-verse window in the same book is a context-key (bold-italic).
2. **Back-list** — the printed keyword list in the back of the quizbook (lists keywords only; says
   nothing about context-keys).
3. **Anki deck** — the user's annotations imported from the colpkg.

Each candidate below is a word where the rule says one thing and the Anki deck says another. Looking
at the printed book disambiguates:

* **Type 3 (BOOK BODY)** — book formatting agrees with the deck (both disagree with the rule). The
  book is the source of truth for what Anki should match, so no Anki fix is needed; the book just
  has inconsistent formatting compared to its own back-list.
* **Type 4 (ANKI TYPE)** — book formatting agrees with the rule and disagrees with the deck. The
  user transcribed it wrong into Anki; fix the annotation.

Scope: 1 Cor 1-16 + 2 Cor 1-13. For 2 Cor 1-6, the Anki deck has annotations to compare against. For
2 Cor 7-13 the deck has no annotations (this section was unannotated at the time of the colpkg
snapshot), so the comparison is just rule vs back-list vs book — findings there are still real Type
3 / Type 4 issues, just discovered by reading the book directly. Three verses (1 Cor 2:5, 8:5,
14:35) are excluded because Anki text differs from canonical, causing wordIndex drift.

### In-verse-repeat pattern

A recurring pattern in the printed book: when a **keyword repeats within a single verse** (e.g.
`foods…foods`, `stomach…stomach` in 1 Cor 6:13, or `regret…regret` in 2 Cor 7:8), the book typesets
it as bold-italic. The rule defines bold-italic strictly as cross-verse repetition within 5 verses,
and the back-list lists these words as keywords. These show up below as "wrong class" Type 3
entries.

---

## Type 4 — to fix in Anki

These words are correctly marked in the printed book but were not captured (or were captured with
the wrong class) when copying into Anki. Each one is a concrete Anki annotation to add or change.

* **1 Cor 9:20 `Jew`** — add bold (currently plain in Anki; bold in book)
* **1 Cor 10:28 `fullness`** — add bold-italic (currently plain in Anki; bold-italic in book)

---

## Type 3 — book formatting issues (no action needed in Anki)

Three failure modes show up:

* _book missed bolding a keyword_ — book leaves a word plain that the back-list lists as a keyword.
* _book missed bold-italicising a context-key_ — book leaves a word plain even though it appears 2+
  times in a 5-verse window.
* _book wrong class_ — book bold-italicises a word that's actually a keyword (or vice-versa). The
  back-list correctly classifies it; the body of the book is inconsistent with its own back-list.

### 1 Corinthians 1

* 1:19 prudent — book missed bolding a keyword

### 1 Corinthians 2

* 2:13 teaches — book wrong class (bold-italic; should be bold)
* 2:15 rightly — book missed bolding a keyword

### 1 Corinthians 3

* 3:10 builds — book missed bold-italicising a context-key
* 3:10 foundation — book missed bold-italicising a context-key
* 3:11 foundation — book missed bold-italicising a context-key
* 3:12 builds — book missed bold-italicising a context-key
* 3:12 foundation — book missed bold-italicising a context-key
* 3:13 fire — book missed bold-italicising a context-key
* 3:15 fire — book missed bold-italicising a context-key
* 3:19 catches — book missed bolding a keyword

### 1 Corinthians 5

* 5:6 leaven — book missed bold-italicising a context-key
* 5:7 leaven — book missed bold-italicising a context-key
* 5:8 leaven — book missed bold-italicising a context-key
* 5:9 immoral — book missed bold-italicising a context-key
* 5:9 sexually — book missed bold-italicising a context-key
* 5:10 immoral — book missed bold-italicising a context-key
* 5:10 sexually — book missed bold-italicising a context-key
* 5:11 immoral — book missed bold-italicising a context-key
* 5:11 sexually — book missed bold-italicising a context-key

### 1 Corinthians 6

* 6:13 foods — book wrong class (bold-italic; should be bold)
* 6:13 stomach — book wrong class (bold-italic; should be bold)

### 1 Corinthians 7

* 7:9 passion — book missed bolding a keyword
* 7:11 divorce — book missed bold-italicising a context-key
* 7:12 divorce — book missed bold-italicising a context-key
* 7:13 divorce — book missed bold-italicising a context-key
* 7:14 unbelieving — book wrong class (bold-italic; should be bold)
* 7:15 cases — book missed bolding a keyword
* 7:18 circumcised — book wrong class (bold-italic; should be bold)
* 7:18 uncircumcised — book wrong class (bold-italic; should be bold)
* 7:21 slave — book missed bold-italicising a context-key
* 7:22 slave — book missed bold-italicising a context-key
* 7:24 state — book missed bolding a keyword
* 7:27 loosed — book wrong class (bold-italic; should be bold)
* 7:30 weep — book wrong class (bold-italic; should be bold)
* 7:32 cares — book missed bold-italicising a context-key
* 7:33 cares — book missed bold-italicising a context-key
* 7:34 cares — book missed bold-italicising a context-key
* 7:38 marriage — book wrong class (bold-italic; should be bold)

### 1 Corinthians 9

* 9:7 flock — book wrong class (bold-italic; should be bold)
* 9:9 muzzle — book missed bolding a keyword
* 9:9 ox — book missed bolding a keyword
* 9:9 treads — book missed bolding a keyword
* 9:13 offerings — book missed bolding a keyword
* 9:19 win — book missed bold-italicising a context-key
* 9:20 win — book missed bold-italicising a context-key
* 9:21 win — book missed bold-italicising a context-key
* 9:22 win — book missed bold-italicising a context-key
* 9:24 run — book missed bold-italicising a context-key
* 9:25 crown — book wrong class (bold-italic; should be bold)
* 9:26 run — book missed bold-italicising a context-key

### 1 Corinthians 10

* 10:4 drank — book wrong class (bold-italic; should be bold)
* 10:4 rock — book wrong class (bold-italic; should be bold)
* 10:7 play — book missed bolding a keyword
* 10:7 sat — book missed bolding a keyword
* 10:13 temptation — book wrong class (bold-italic; should be bold)
* 10:20 demons — book missed bold-italicising a context-key
* 10:20 sacrifice — book wrong class (bold-italic; should be bold)
* 10:21 demons — book missed bold-italicising a context-key
* 10:21 table — book wrong class (bold-italic; should be bold)
* 10:25 conscience' — book missed bold-italicising a context-key
* 10:27 conscience' — book missed bold-italicising a context-key
* 10:27 dinner — book missed bolding a keyword
* 10:28 conscience' — book missed bold-italicising a context-key

### 1 Corinthians 11

* 11:4 covered — book missed bold-italicising a context-key
* 11:6 covered — book missed bold-italicising a context-key
* 11:6 shorn — book wrong class (bold-italic; should be bold)
* 11:10 symbol — book missed bolding a keyword
* 11:11 independent — book wrong class (bold-italic; should be bold)
* 11:14 hair — book missed bold-italicising a context-key
* 11:15 hair — book missed bold-italicising a context-key
* 11:20 supper — book missed bold-italicising a context-key
* 11:21 supper — book missed bold-italicising a context-key
* 11:25 supper — book missed bold-italicising a context-key
* 11:27 drinks — book missed bold-italicising a context-key
* 11:27 eats — book missed bold-italicising a context-key
* 11:29 drinks — book missed bold-italicising a context-key
* 11:29 eats — book missed bold-italicising a context-key

### 1 Corinthians 12

* 12:17 hearing — book wrong class (bold-italic; should be bold)

### 1 Corinthians 14

* 14:11 foreigner — book wrong class (bold-italic; should be bold)
* 14:15 conclusion — book missed bolding a keyword
* 14:15 sing — book wrong class (bold-italic; should be bold)
* 14:21 lips — book missed bolding a keyword
* 14:33 author — book missed bolding a keyword
* 14:36 originally — book missed bolding a keyword

### 1 Corinthians 15

* 15:14 empty — book wrong class (bold-italic; should be bold)
* 15:32 tomorrow — book missed bolding a keyword
* 15:36 sow — book missed bold-italicising a context-key
* 15:37 sow — book missed bold-italicising a context-key
* 15:40 celestial — book wrong class (bold-italic; should be bold)
* 15:40 terrestrial — book wrong class (bold-italic; should be bold)
* 15:41 star — book wrong class (bold-italic; should be bold)
* 15:47 dust — book missed bold-italicising a context-key
* 15:48 dust — book missed bold-italicising a context-key
* 15:48 heavenly — book missed bold-italicising a context-key
* 15:49 dust — book missed bold-italicising a context-key
* 15:49 heavenly — book missed bold-italicising a context-key
* 15:54 victory — book missed bold-italicising a context-key
* 15:55 hades — book missed bolding a keyword
* 15:55 victory — book missed bold-italicising a context-key
* 15:57 victory — book missed bold-italicising a context-key

### 2 Corinthians 1

* 1:5 sufferings — book missed bold-italicising a context-key
* 1:6 sufferings — book missed bold-italicising a context-key
* 1:7 sufferings — book missed bold-italicising a context-key
* 1:11 granted — book missed bolding a keyword
* 1:17 plan — book wrong class (bold-italic; should be bold)

### 2 Corinthians 2

* 2:6 inflicted — book missed bolding a keyword
* 2:10 forgiven — book wrong class (bold-italic; should be bold)
* 2:16 aroma — book wrong class (bold-italic; should be bold)

### 2 Corinthians 3

* 3:1 commendation — book wrong class (bold-italic; should be bold)
* 3:3 tablets — book wrong class (bold-italic; should be bold)
* 3:7 glorious — book missed bold-italicising a context-key
* 3:8 glorious — book missed bold-italicising a context-key
* 3:10 glorious — book missed bold-italicising a context-key
* 3:11 glorious — book missed bold-italicising a context-key
* 3:13 veil — book missed bold-italicising a context-key
* 3:14 veil — book missed bold-italicising a context-key
* 3:15 veil — book missed bold-italicising a context-key
* 3:16 veil — book missed bold-italicising a context-key

### 2 Corinthians 4

* 4:3 veiled — book wrong class (bold-italic; should be bold)
* 4:17 eternal — book missed bold-italicising a context-key
* 4:18 eternal — book missed bold-italicising a context-key

### 2 Corinthians 5

* 5:1 eternal — book missed bold-italicising a context-key
* 5:12 answer — book missed bolding a keyword

### 2 Corinthians 6

* 6:2 acceptable — book missed bolding a keyword
* 6:12 restricted — book wrong class (bold-italic; should be bold)
* 6:16 dwell — book missed bolding a keyword
* 6:17 separate — book missed bolding a keyword
* 6:18 almighty — book missed bolding a keyword
* 6:18 daughters — book missed bolding a keyword
* 6:18 sons — book missed bolding a keyword

### 2 Corinthians 7

* 7:8 sorry — book missed bold-italicising a context-key (also 7:9)
* 7:8 regret — book wrong class (bold-italic; should be bold) — in-verse-repeat
* 7:9 sorry — book missed bold-italicising a context-key
* 7:10 produces — book wrong class (bold-italic; should be bold) — in-verse-repeat

### 2 Corinthians 8

* 8:3 ability — book wrong class (bold-italic; should be bold) — in-verse-repeat
* 8:14 equality — book wrong class (bold-italic; should be bold) — in-verse-repeat
* 8:17 diligent — book missed bold-italicising a context-key
* 8:22 diligent — book missed bold-italicising a context-key
* 8:23 inquired — book missed bolding a keyword
* 8:23 inquires — book missed bolding a keyword

### 2 Corinthians 9

* 9:6 sows — book wrong class (bold-italic; should be bold) — in-verse-repeat
* 9:6 sparingly — book wrong class (bold-italic; should be bold) — in-verse-repeat
* 9:6 bountifully — book wrong class (bold-italic; should be bold) — in-verse-repeat
* 9:9 abroad — book missed bolding a keyword
* 9:9 dispersed — book missed bolding a keyword

### 2 Corinthians 10

* 10:13 sphere — book missed bold-italicising a context-key
* 10:15 sphere — book missed bold-italicising a context-key
* 10:16 sphere — book missed bold-italicising a context-key
* 10:18 commends — book wrong class (bold-italic; should be bold) — in-verse-repeat

### 2 Corinthians 11 — no findings

### 2 Corinthians 12

* 12:5 infirmities — book missed bold-italicising a context-key
* 12:9 infirmities — book missed bold-italicising a context-key
* 12:10 infirmities — book missed bold-italicising a context-key
* 12:12 signs — book wrong class (bold-italic; should be bold) — in-verse-repeat
* 12:14 parents — book wrong class (bold-italic; should be bold) — in-verse-repeat

### 2 Corinthians 13

* 13:1 established — book missed bolding a keyword
* 13:1 mouth — book missed bolding a keyword
