# Content Pipeline

Scripts for maintaining the verse-vault deck data.

## Architecture

Three sources, one runtime payload:

```
api.bible      → canonical NKJV text         (cached in apibible_passages)
corinthians.json → phraseWordCounts,         (committed structural file —
                   annotations,                source of truth for project
                   ftvWordCount,               metadata)
                   headings, clubs
Anki .colpkg   → clubs only                  (just for refreshing the tier
                                              membership field; rest of
                                              the deck stays in git)
```

Runtime (`packages/api/src/lib/render.ts`) reads `corinthians.json` for the structure, fetches
canonical chapter HTML from the api.bible cache, and composes per-verse HTML by slicing api.bible
tokens with the deck's word counts and annotation indices.

The audit/editing tools below operate on the same two stores.

## Tools

### `evaluate_phrases.py`

Audit `phraseWordCounts` in the structural deck against api.bible's canonical token counts. Flags
deck/canonical drift, fragments below the 3-word minimum mid-verse, runs over 12 words, and missing
splits on long single-phrase verses.

```bash
python3 tools/evaluate_phrases.py --top 20
python3 tools/evaluate_phrases.py --refs "1 Cor 12:11,1 Cor 1:26"
python3 tools/evaluate_phrases.py --llm-judge   # ANTHROPIC_API_KEY needed
python3 tools/evaluate_phrases.py --out /tmp/report.json
```

### `split_phrases.py`

Re-split verses by feeding canonical text + the existing split to an LLM and applying the proposed
phrase boundaries back to `phraseWordCounts`.

```bash
# emit the prompt(s) for one or more verses
python3 tools/split_phrases.py print-prompt --refs "1 Cor 12:11"

# pull refs straight out of the evaluator's worst-first report
python3 tools/split_phrases.py print-prompt --from-report /tmp/report.json --top 10 --json

# apply proposed [{ref, phrases}] back to corinthians.json
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

Refresh only the `clubs` field on each verse in `corinthians.json` from an Anki `.colpkg` backup.
Everything else (phrase splits, annotations, FTV) stays as authored in the structural file.

```bash
python3 tools/import_colpkg.py data/collection-*.colpkg --year 3-C
python3 tools/import_colpkg.py data/collection-*.colpkg --year 3-C --dry-run
```

## api.bible cache

The api.bible HTML cache lives in `packages/api/data/verse-vault.db` (table `apibible_passages`).
Both the live server (`render.ts`'s `ApibibleCache`) and the tools above share that store — one
fetch, one 30-day TTL, one MAUA-compliant surface.

Tools auto-create the table on first run if the API migrations haven't been applied yet, and they
fall through to a fresh fetch when an entry is missing or past the 30-day TTL. Set `BIBLE_API_KEY`
(or `API_BIBLE_KEY`) in the environment for the fallback fetch to succeed.

Subject to the
[API.Bible Minimum Acceptable Use Agreement](https://docs.api.bible/guides/terms-of-use):

* Cached scripture is re-fetched within 30 days of capture.
* Cached content is for runtime + diagnostic use only — never for training generative AI.
* Starter-plan callers must include a visible citation + link to https://api.bible in any UI
  surfacing the content.

## File map

| File                               | Tracked?   | Role                                                   |
| ---------------------------------- | ---------- | ------------------------------------------------------ |
| `data/corinthians.json`            | committed  | structural deck (source of truth for project metadata) |
| `packages/api/data/verse-vault.db` | gitignored | API SQLite incl. `apibible_passages` cache             |
| `data/collection-*.colpkg`         | gitignored | Anki backups (clubs source + audit input)              |

## Phrase-splitter helper package

`tools/phrase_splitter/` carries shared helpers + prompts:

* `apibible.py` — open the cache, fetch chapter HTML, extract per-verse tokens. Used by every
  audit/editing tool.
* `prompts.py` — `SPLIT_PROMPT` (the LLM prompt for re-splitting) and `JUDGE_PROMPT` (the optional
  quality auditor).
* `helpers.py` — shared text utilities (severity ranks, reference parsing/normalisation, HTML strip,
  word-level normalisation for audits) used across the phrase-splitter and audit tools.
