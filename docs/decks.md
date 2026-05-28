# Deck inventory & split provenance

One row per `data/<N>-*.json`. NKJV files are the canonical decks; `-niv` suffixes are translation
side-decks against api.bible NIV 2011 (bibleId `78a9f6124f344018-01`).

Every NKJV deck has been through multiple iterative passes — the splitter pipeline evolved during
their construction (deterministic auditor + LLM splitter + LLM judge), and verses got re-scored,
re-split, and judge-gated across releases. The NIV side-decks are newer and have only been through
the v0.5 pipeline as documented below.

`multi-split %` is the share of verses with at least one boundary; the balance are short verses
(single phrase is the correct call) — not unsplit defects. `0 / N` in the FTV-mismatch /
keyword-flag columns means the deterministic auditors (`tools/find_ftvs.py --audit`,
`tools/find_keywords.py`) report no disagreement with the deck's `ftvWordCount` / `annotations`.
"Ambig" counts verses with no unique opening prefix across the deck — duplicate salutations and
refrains where the deck's `ftvWordCount` is intentionally `null`.

## Year decks

| File                     | Tx   | Books                                    | Verses | Multi-split % | Split method                                                                                                                       | FTV / Ambig                                             | Keyword flags |
| ------------------------ | ---- | ---------------------------------------- | ------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------- |
| `1-gepc.json`            | NKJV | Gal, Eph, Php, Col                       | 503    | 94%           | Phases 1 + 3                                                                                                                       | 0 / 0                                                   | 0             |
| `2-nt-survey.json`       | NKJV | Mt, Acts, 1Th, 1Tim, 2Tim, Tit, 1Jn, Rev | 812    | 94%           | Phases 1 + 3                                                                                                                       | 0 / 0                                                   | 0             |
| `3-corinthians.json`     | NKJV | 1–2 Cor                                  | 694    | 92%           | Phases 1 + 2 + 3 (one of the two most-iterated decks)                                                                              | 0 / 2 (1 Cor 1:3, 2 Cor 1:2 — Pauline salutation)       | 0             |
| `4-john.json`            | NKJV | John                                     | 879    | 92%           | Phases 1 + 2 + 3 (one of the two most-iterated decks)                                                                              | 0 / 0                                                   | 0             |
| `5-hp.json`              | NKJV | Heb, 1–2 Pet                             | 469    | 97%           | Phases 1 + 3                                                                                                                       | 0 / 0                                                   | 0             |
| `6-ot-survey.json`       | NKJV | (OT survey, 18 books)                    | 780    | 97%           | Phases 1 + 3                                                                                                                       | 0 / 2 (Ps 46:7, 46:11 — refrain, marked `0` not `null`) | 0             |
| `7-rj.json`              | NKJV | Rom, Jas                                 | 541    | 94%           | Phases 1 + 3                                                                                                                       | 0 / 0                                                   | 0             |
| `8-luke.json`            | NKJV | Luke                                     | 791    | 95%           | Phases 1 + 3                                                                                                                       | 0 / 0                                                   | 0             |
| `1-gepc-niv.json`        | NIV  | Gal, Eph, Php, Col                       | 503    | 0%            | **Placeholder** (no splits yet)                                                                                                    | 0 / 3                                                   | 0             |
| `2-nt-survey-niv.json`   | NIV  | Mt, Acts, … Rev                          | 812    | 0%            | **Placeholder**                                                                                                                    | 0 / 0                                                   | 0             |
| `3-corinthians-niv.json` | NIV  | 1–2 Cor                                  | 694    | 0%            | **Placeholder**                                                                                                                    | 0 / 2 (1 Cor 1:3, 2 Cor 1:2)                            | 0             |
| `4-john-niv.json`        | NIV  | John                                     | 879    | 51%           | **Partial force-fresh single pass** (Sonnet subagents, 34 of 59 batches completed; weekly limit cut off batches 14, 22, 24, 36–58) | 0 / 0                                                   | 0             |
| `5-hp-niv.json`          | NIV  | Heb, 1–2 Pet                             | 469    | 93%           | **Force-fresh single pass** (Sonnet subagents, 32 batches all completed)                                                           | 0 / 0                                                   | 0             |
| `6-ot-survey-niv.json`   | NIV  | (OT survey, 18 books)                    | 780    | 0%            | **Placeholder**                                                                                                                    | 0 / 3 (Ex 14:1 new to NIV, Ps 46:7, 46:11)              | 0             |
| `7-rj-niv.json`          | NIV  | Rom, Jas                                 | 541    | 0%            | **Placeholder**                                                                                                                    | 0 / 0                                                   | 0             |
| `8-luke-niv.json`        | NIV  | Luke                                     | 791    | 0%            | **Placeholder**                                                                                                                    | 0 / 2                                                   | 0             |

## Methodology

### NKJV — multi-pass (current state)

Each NKJV deck has been through three phases as the pipeline matured. The shipping form of the
splitter loop is the v0.5 form described in `.claude/skills/phrase-splitter/SKILL.md`: deterministic
auditor scores each verse, LLM splitter proposes alternatives, deterministic re-audit, then an LLM
judge picks A (keep) or B (replace) per verse. Stability lives only in the judge's tie-break rule.
Prior versions (pre-v0.5) shaped many of the current boundaries; the per-deck histories below record
which passes touched each one.

#### Phase 1 — foundational seed + alignment

Touched all 8 decks. From oldest to newest:

| Commit                                                       | Effect                                                                                        |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `014b2f8` `feat: commit structural corinthians.json`         | First deck (1–2 Cor); structural-only shape.                                                  |
| `340e121` `refactor: name deck file by year (3-corinthians)` | Year-numbered filenames; `.gitignore` whitelist generalised.                                  |
| `e22cc90` `feat: seed john (year 4) deck file`               | Second deck (John, year 4).                                                                   |
| `d529d6c` `feat: annotations from rule, not book body`       | Annotations re-derived from the keyword rule, not the printed quizbook.                       |
| `8c1ad0b` `feat: seed deck files for years 1, 2, 5, 6, 7, 8` | Remaining six year-decks bootstrapped from the 2026-05-08 colpkg.                             |
| `9b2ecc6` `fix: bring all 8 deck files into rule-alignment`  | `find_keywords.py` + `find_ftvs.py` clean across every deck.                                  |
| `c49f0fd` `fix: regenerate decks via content-based pipeline` | `init_deck.py` rewritten to align by content (token-stream positions), not Anki HTML offsets. |
| `0f28234` `fix: refresh decks from latest colpkg`            | Decks re-pulled from the 2026-05-12 14:35 colpkg with the new tokeniser.                      |

Per-deck structural fixes during this phase:

* `4-john` — `76c31d3 fix: add missing John 13:10 to year 4 deck`.
* `5-hp` — `114f361 feat: expand year 5 deck to full chapters`.
* `6-ot-survey` — `ef4481f feat: expand year 6 (OT Survey) to full material` and
  `5edf8ea fix: extend Micah 7 range to 18-19 in year 6 full`.
* `7-rj` — `a967bf1 feat: expand year 7 (RJ) to full chapters`.

#### Phase 2 — per-deck iterative resplits

Only `3-corinthians` and `4-john` went through this — they were the two earliest decks and absorbed
the pipeline's evolution before it stabilised. The other six skipped straight from phase 1 to phase
3.

`3-corinthians` (year 3, 1–2 Cor):

| Commit                                                  | Effect                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `4171e49` `fix: resplit phrases in year 3`              | 347 verses rewritten — 30 drift cases, 141 placeholder-only verses (all of 2 Cor 7–13), ~160 out-of-band phrase lengths. |
| `7a4942c` `fix: merge verb-clause splits in year 3`     | Auditor-flagged verb + content-clause severances rejoined across 9 verses.                                               |
| `37e114b` `fix(tools): resplit 1 Cor 1-8 from scratch`  | First force-fresh quarter.                                                                                               |
| `ea5541a` `fix(tools): resplit 1 Cor 9-16 from scratch` | Second quarter.                                                                                                          |
| `4a7cea7` `fix(tools): resplit 2 Cor 1-7 from scratch`  | Third quarter.                                                                                                           |
| `a5af0b9` `fix(tools): resplit 2 Cor 8-13 from scratch` | Fourth quarter.                                                                                                          |
| `793ac49` `fix(tools): second pass 1-2 Cor with judge`  | Pre-v0.5 judge gate over the four resplit quarters.                                                                      |

`4-john` (year 4, John):

| Commit                                                      | Effect                                                                                                                      |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `8e25605` `fix: split phrases in year 4`                    | First bulk split — 814 verses rewritten across 54 subagent batches.                                                         |
| `b781d57` `fix(tools): resplit john 1:3 to keep clause`     | Specific fix establishing the restrictive-clause pattern.                                                                   |
| `79d74cc` `fix(tools): resplit john restrictive clauses`    | 101 verses where restrictive relatives or verb content clauses had been severed.                                            |
| `faa8a27` `fix(tools): resplit John 1-5 from scratch`       | First force-fresh fifth.                                                                                                    |
| `0967010` `fix(tools): resplit John 6-10 from scratch`      | Second fifth.                                                                                                               |
| `6b28396` `fix(tools): resplit John 11-15 from scratch`     | Third fifth.                                                                                                                |
| `22e1722` `fix(tools): resplit John 16-21 from scratch`     | Fourth fifth.                                                                                                               |
| `faff832` `fix(tools): 2nd-pass resplit on worst 20 verses` | Pre-v0.5 judge gate over the 20 highest-signal verses post-resplit. Splitter accepted 6 boundary changes, kept 14 verbatim. |

#### Phase 3 — standard v0.5 three-pass loop

Touched all 8 decks identically (same SPLIT_PROMPT + JUDGE_PROMPT), in this order:

| Pass | Splitter | Judge | Purpose                                                              |
| ---- | -------- | ----- | -------------------------------------------------------------------- |
| 1    | Sonnet   | —     | Fresh split per verse (no judge — calibration pass).                 |
| 2    | Sonnet   | Opus  | Sonnet proposes, Opus judges A/B against the pass-1 split.           |
| 3    | Opus     | Opus  | Opus proposes against the pass-2 split, Opus judges A/B. Final ship. |

Per-deck commit pairs (newest to oldest within each deck):

| Deck            | Pass 1 (split) | Pass 2 (s+o-judge) | Pass 3 (opus+opus) |
| --------------- | -------------- | ------------------ | ------------------ |
| `1-gepc`        | `053796c`      | `8a25567`          | `62c1a68`          |
| `2-nt-survey`   | `61f924f`      | `aa73ad6`          | `9c89dd7`          |
| `3-corinthians` | `c78aa53`      | `ff84fa6`          | `340b85e`          |
| `4-john`        | `d98079b`      | `b6d2ec6`          | `64a4ba6`          |
| `5-hp`          | `92ce8a9`      | `7bc4756`          | `043c876`          |
| `6-ot-survey`   | `419219d`      | `e582971`          | `affef9c`          |
| `7-rj`          | `3fafbf2`      | `9ddfbba`          | `6213d4c`          |
| `8-luke`        | `4f38d53`      | `ef8a1e0`          | `ebffcf3`          |

### Side-decks (any non-source translation) — same pipeline as NKJV

The same `tools/split_phrases.py` + `tools/evaluate_phrases.py` + `tools/find_ftvs.py` +
`tools/find_keywords.py` chain handles any translation via `--bible <bibleId>`. The only
translation-shaped script is `tools/init_side_deck.py`, which clones the source deck's structural
fields against a different bibleId and writes single-phrase placeholder splits + `annotations: []` +
`ftvWordCount: null`.

The bootstrap → finished flow:

1. `tools/init_side_deck.py --source data/N-x.json --out data/N-x-niv.json --bible <id>`
2. `tools/find_ftvs.py data/N-x-niv.json --bible <id> --out /tmp/ftv.json` → write the computed
   `shortest_unique_prefix_words` back into the deck's `ftvWordCount` (verses with no unique prefix
   stay `null`).
3. `tools/apply_keyword_annotations.py data/N-x-niv.json --bible <id>` — derives `annotations`
   deterministically from the keyword / context-key rules over the target's canonical text.
4. `tools/evaluate_phrases.py data/N-x-niv.json --bible <id> --all --out /tmp/eval.json` →
   `tools/split_phrases.py --deck data/N-x-niv.json --bible <id> print-prompt --all-verses --no-current --no-signals --outdir /tmp/batches --batch-size 15`
   — emits batched force-fresh prompts (no current split or signal context).
5. Dispatch parallel splitter subagents per
   `.claude/skills/phrase-splitter/references/splitter-agent-instructions.md` (small batches, Sonnet
   for speed or Opus for peak quality).
6. `tools/split_phrases.py --deck data/N-x-niv.json --bible <id> apply --input /tmp/proposals.json`
   — validates word-count sum AND a byte-exact rejoin; falls back to a smart-quote splice when the
   only divergence is ASCII vs curly quotes (a Sonnet quirk on translations).
7. Force-fresh skips the judge step (no current to compare against). On a second pass — once the
   side-deck has real splits — re-run `evaluate_phrases.py` against the side-deck, follow the
   standard v0.5 audit-flagged split + judge + apply loop.

NIV-omitted verses (e.g. John 5:4, Acts 15:34, Rom 16:24, Luke 17:36 / 23:17 — bracketed or
footnoted in the NIV) keep their NKJV reference in the deck but carry an empty `phraseWordCounts`
array. They're skipped by all renderers + auditors.

### What "placeholder" means

A placeholder NIV deck has every verse's `phraseWordCounts` initialised to a single-element array
equal to the canonical NIV token count — i.e. the whole verse is one phrase. The deck is
structurally valid: it renders, audits clean, and round-trips through every tool. It just doesn't
slice verses into memorisation chunks yet. Running the splitter pipeline against the placeholder
advances it to a real split without touching FTVs or annotations.
