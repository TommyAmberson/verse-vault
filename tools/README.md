# Content Pipeline

Scripts for maintaining the verse-vault deck data.

## Architecture

Three sources, one runtime payload:

```
api.bible      → canonical NKJV text         (cached in apibible_passages)
3-corinthians.json → phraseWordCounts,         (committed structural file —
                   annotations,                source of truth for project
                   ftvWordCount,               metadata)
                   headings, clubs
Anki .colpkg   → clubs only                  (just for refreshing the tier
                                              membership field; rest of
                                              the deck stays in git)
```

Runtime (`packages/api/src/lib/render.ts`) reads `3-corinthians.json` for the structure, fetches
canonical chapter HTML from the api.bible cache, and composes per-verse HTML by slicing api.bible
tokens with the deck's word counts and annotation indices.

The audit/editing tools below operate on the same two stores.

## Tools

### `evaluate_phrases.py`

Audit `phraseWordCounts` in the structural deck against api.bible's canonical token counts. Emits
one record per verse with two layers: structural **blockers** (deck/canonical sum drift, missing
canonical tokens, unbalanced HTML inside a phrase, ftv out of range) that must be fixed before
re-splitting, and a numeric **signal_score** in `[0, 1]` plus the full signals payload from the
features module. The judge step is gone — the splitter prompt now folds in that judgement.

```bash
python3 tools/evaluate_phrases.py --top 20
python3 tools/evaluate_phrases.py data/4-john.json --min-score 0.3
python3 tools/evaluate_phrases.py --refs "1 Cor 12:11,1 Cor 1:26" --all
python3 tools/evaluate_phrases.py --out /tmp/report.json --all
```

### `split_phrases.py`

Re-split verses by feeding canonical text + the existing split + a signals block to an LLM, then
applying the proposed phrase boundaries back to `phraseWordCounts`. The prompt's stability clause
biases the LLM toward returning the current split unchanged when it already passes the stand-alone
test.

```bash
# emit the prompt(s) for one or more verses (current split + signals included by default)
python3 tools/split_phrases.py print-prompt --refs "1 Cor 12:11"

# bypass the current-split and signals sections (single-verse paste path)
python3 tools/split_phrases.py print-prompt --refs "1 Cor 12:11" --no-current --no-signals

# pull refs straight out of the evaluator's worst-first report
python3 tools/split_phrases.py print-prompt --from-report /tmp/report.json --top 10 --json

# apply proposed [{ref, phrases}] back to 3-corinthians.json
python3 tools/split_phrases.py apply --input /tmp/proposed.json --dry-run
python3 tools/split_phrases.py apply --input /tmp/proposed.json
```

Annotation `wordIndex` values and `ftvWordCount` are positions in the canonical token stream and
don't shift when only the split boundaries change, so they're preserved.

### `find_ftvs.py`

Compute the shortest unique opening word-prefix per verse (across all verses in the material) and
optionally diff against the deck's current `ftvWordCount`.

```bash
python3 tools/find_ftvs.py
python3 tools/find_ftvs.py --audit          # flags too-short or longer-than-needed
python3 tools/find_ftvs.py --out /tmp/ftv.json
```

### `find_keywords.py`

Audit `annotations` (`bold` = keyword, `boldItalic` = context-key) against the canonical-text
occurrences. Surfaces over-marked, under-marked, and wrong-kind cases.

```bash
python3 tools/find_keywords.py
python3 tools/find_keywords.py --kind context-key
python3 tools/find_keywords.py --out /tmp/keywords.json
```

Rules:

* Keyword (`bold`): word appears in exactly one verse in the material.
* Context key (`boldItalic`): word appears in multiple verses whose first-to-last verse-index gap is
  ≤ 5 within a single book.

### `audit_colpkg.py`

Read-only diff of an Anki `.colpkg` against the structural deck + canonical NKJV. Flags drift across
four kinds:

* `text` — Anki verse text vs api.bible canonical (typos, edits)
* `ftv` — Anki FTV-field word count vs deck `ftvWordCount`
* `keys` — Anki `<b>` / `<b><i>` positions vs deck `annotations`
* `clubs` — Anki club field vs deck `clubs`

```bash
python3 tools/audit_colpkg.py data/collection-*.colpkg --year 3-C
python3 tools/audit_colpkg.py data/collection-*.colpkg --year 3-C --checks text,ftv
python3 tools/audit_colpkg.py data/collection-*.colpkg --year 3-C --out /tmp/audit.json
```

### `import_colpkg.py`

Refresh only the `clubs` field on each verse in `3-corinthians.json` from an Anki `.colpkg` backup.
Everything else (phrase splits, annotations, FTV) stays as authored in the structural file.

```bash
python3 tools/import_colpkg.py data/collection-*.colpkg --year 3-C
python3 tools/import_colpkg.py data/collection-*.colpkg --year 3-C --dry-run
```

### `init_deck.py`

One-shot bootstrap for a new year's structural deck file. Combines the Anki `.colpkg` (annotations,
FTV, clubs) with the api.bible canonical text (phrase word counts, chapter ranges) and section list
(headings) to produce a complete `data/<year>-<book>.json`. Refuses to overwrite an existing file
without `--force`.

```bash
python3 tools/init_deck.py data/collection-*.colpkg \
  --year 4-J --year-num 4 --books John \
  --out data/4-john.json

# Multi-book year (e.g. Hebrews + 1+2 Peter):
python3 tools/init_deck.py data/collection-*.colpkg \
  --year 5-HP --year-num 5 --books "Hebrews,1 Peter,2 Peter" \
  --out data/5-hp.json
```

## api.bible cache

The api.bible HTML cache lives in `packages/api/data/verse-vault.db` (table `apibible_passages`).
Both the live server (`render.ts`'s `ApibibleCache`) and the tools above share that store — one
fetch, one 30-day TTL, one MAUA-compliant surface.

Tools auto-create the table on first run if the API migrations haven't been applied yet, and they
fall through to a fresh fetch when an entry is missing or past the 30-day TTL. Set `BIBLE_API_KEY`
(or `API_BIBLE_KEY`) in the environment for the fallback fetch to succeed.

Subject to the [API.Bible Terms of Service](https://api.bible/terms-and-conditions) — in particular
the [Acceptable Use](https://api.bible/terms-and-conditions#acceptable_use) clause and the
[licensing & access overview](https://docs.api.bible/quick-start/licensing-and-access):

* Cached scripture is re-fetched within 30 days of capture (TTL-on-read + prune-on-load).
* Cached content is for runtime + diagnostic use only — never used to train generative AI or LLMs.
* Text content stays in text form — no derivative-format conversion (text → audio, etc.).
* No systematic bulk extraction of scripture into separate databases. Server-side fetches are one
  passage at a time; the planned client-side render cache is opt-in per device.
* Starter-plan callers must include a visible citation + link to https://api.bible in any UI
  surfacing the content. See [`NOTICE.md`](../NOTICE.md) for the NKJV citation.

## File map

| File                               | Tracked?   | Role                                                   |
| ---------------------------------- | ---------- | ------------------------------------------------------ |
| `data/3-corinthians.json`          | committed  | structural deck (source of truth for project metadata) |
| `packages/api/data/verse-vault.db` | gitignored | API SQLite incl. `apibible_passages` cache             |
| `data/collection-*.colpkg`         | gitignored | Anki backups (clubs source + audit input)              |

## Phrase-splitter helper package

`tools/phrase_splitter/` carries shared helpers, the features layer, and prompts:

* `apibible.py` — open the cache, fetch chapter HTML, extract per-verse tokens. Used by every
  audit/editing tool.
* `features.py` — deterministic signal extraction over a verse's phrase split. Emits per-phrase
  features (cognitive weight, function ratio, weak-connector starts, mid-clause endings) and
  per-boundary features (restrictive-relative, verb + content clause), plus a composite
  `signal_score` in `[0, 1]` that drives the auditor's `--top` / `--min-score`. The auditor and the
  splitter both consume this as context.
* `prompts.py` — `SPLIT_PROMPT` + the `format_split_prompt(verse_text, current_split, signals)`
  helper. The current-split section carries the stability clause that folds the old LLM-judge step
  into the splitter call.
* `helpers.py` — shared text utilities (reference parsing/normalisation, HTML strip, word-level
  normalisation) used across the phrase-splitter and audit tools.
