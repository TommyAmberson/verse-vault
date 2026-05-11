# Content Pipeline

Scripts for converting Bible content into verse-vault's intermediate JSON format.

## Pipeline overview

The fast path imports an Anki `.colpkg` backup directly and reuses already-chunked phrases from a
sidecar cache, so the splitter only runs for verses whose text actually changed:

```
Anki .colpkg backup
    │
    ▼
import_colpkg.py + phrases cache ──→ JSON
    │
    ▼
(if any verses lacked a cached split — or any are flagged as low-quality)
evaluate_phrases.py ──→ report.json (worst splits, with reasons)
    │
    ▼
split_phrases.py print-prompt ──→ LLM ──→ split_phrases.py apply
    │
    ▼
extract_phrases.py ──→ updated phrases cache (commit)
    │
    ▼
derive_structure.py ──→ structural corinthians.json (commit)
```

The "from text export" path (`parse_anki.py` → splitter → cache) still works and is documented at
the bottom.

## Fast path: re-importing from a colpkg

### 1. Drop the .colpkg in `data/`

Anki desktop: `File → Export → Anki Collection Package → with scheduling/media as you like`.

### 2. Run the importer with the cached phrases

```bash
python3 tools/import_colpkg.py \
    data/collection-2026-05-08.colpkg \
    data/corinthians-parsed.json \
    --year 3-C \
    --phrases data/corinthians-phrases.json
```

The script extracts the SQLite (handles zstd-compressed `collection.anki21b`), reads the `Verse` and
`Heading` notetypes, and merges in cached splits from the phrases sidecar. Verses whose text matches
the cache reuse the cached phrases; mismatches fall back to `[whole verse]` and are listed at exit.

### 3. Audit splits

Run the evaluator over the phrase cache to surface the verses that need attention — both new verses
still on the placeholder split and existing verses with quality issues:

```bash
python3 tools/evaluate_phrases.py data/corinthians-phrases.json --top 20
```

The evaluator runs deterministic checks (rejoin invariant, 3-12 word bounds per phrase, balanced
HTML, missing-split detection on 10+ word single-phrase verses) and ranks issues by severity
(`blocker` > `high` > `medium` > `low`). Pass `--llm-judge` to also ask Claude Haiku to audit the
splits that passed the deterministic checks; that requires the `anthropic` package and
`ANTHROPIC_API_KEY` in the environment. Pass `--out report.json` to capture the report for the next
step.

### 4. Re-split the flagged verses

`split_phrases.py print-prompt` emits the LLM prompt for each ref. The prompt lives in
`tools/phrase_splitter/prompts.py` and is shared with the phrase-splitter skill so iterations land
in one place.

```bash
# Print prompts for the worst 10 entries in the report
python3 tools/split_phrases.py print-prompt data/corinthians-phrases.json \
    --from-report report.json --top 10 --json > /tmp/prompts.json

# Or target specific refs directly
python3 tools/split_phrases.py print-prompt data/corinthians-phrases.json \
    --refs "1 Cor 12:11,1 Cor 1:26"
```

Feed each prompt to an LLM (Claude in the terminal, the phrase-splitter skill, the Anthropic API —
any of them), then collect the responses into a JSON file of `{ref, phrases}` objects:

```json
[
  {
    "ref": "1 Corinthians 12:11",
    "phrases": [
      "But one and the same Spirit works all these things,",
      "<b>distributing</b> to each one individually as He wills."
    ]
  }
]
```

Apply with deterministic validation (rejoin + bounds + HTML balance):

```bash
python3 tools/split_phrases.py apply data/corinthians-phrases.json \
    --input /tmp/proposed.json --dry-run    # check without writing
python3 tools/split_phrases.py apply data/corinthians-phrases.json \
    --input /tmp/proposed.json              # write to cache
```

Failures (rejoin mismatch, out-of-bounds phrase, unbalanced HTML) are reported with reasons and the
exit code is non-zero; survivors are written to the cache.

### 5. Refresh the structural deck file

After the cache changes, replay the colpkg with the updated cache to refresh the text-bearing parsed
JSON, then strip it into the committed structural shape:

```bash
python3 tools/import_colpkg.py data/collection-*.colpkg data/corinthians-parsed.json \
    --year 3-C --phrases data/corinthians-phrases.json
python3 tools/derive_structure.py data/corinthians-parsed.json data/corinthians.json
```

`derive_structure.py` strips the verse text and emits the structural shape (`phraseWordCounts`,
`annotations`, `ftvWordCount`, heading ranges, clubs) — the only thing the server and clients
consume at runtime. The intermediate `corinthians-parsed.json` stays gitignored under `data/`; only
`data/corinthians.json` is committed.

### 6. Verify against canonical NKJV (optional)

The Anki deck is the source of truth in this pipeline, but it can drift from the canonical NKJV text
— typos slipping in during edits, etc. `check_against_apibible.py` fetches the chapter via api.bible
(NKJV by default), strips the deck's `<b>`/`<i>`/`<span>` markup, and reports any verses whose
wording diverges:

```bash
export API_BIBLE_KEY=<your api.bible key>
python3 tools/check_against_apibible.py data/corinthians-parsed.json \
    --book "1 Corinthians" --chapter 1
```

Subject to the
[API.Bible Minimum Acceptable Use Agreement](https://docs.api.bible/guides/terms-of-use):

* Fetched passages are cached at `data/apibible-cache.json` and re-fetched after 30 days per the
  cache-refresh requirement.
* Output prints the required citation line.
* The cached content is for **runtime diagnostic use only** — not for training generative AI.
* Starter-plan callers must include a visible citation + link to https://api.bible in any UI
  surfacing the content.

## Fresh start: from a text export

Use this path when there is no existing phrase cache to seed from.

```
Anki export (.txt)
    │
    ▼
parse_anki.py ──→ parsed JSON (phrases = [whole verse])
    │
    ▼
evaluate_phrases.py ──→ flags every long verse as "missing split"
    │
    ▼
split_phrases.py print-prompt → LLM → split_phrases.py apply
    │
    ▼
extract_phrases.py + derive_structure.py
```

### 1. Parse the Anki export

```bash
python3 tools/parse_anki.py data/anki-export.txt data/corinthians-parsed.json --year 3-C
```

This parses the tab-separated Anki export, cleans HTML formatting, and produces the intermediate
JSON. Phrases are initially set to `[whole verse]` as placeholder.

**Text cleaning:**

* Anki CSV quote escaping removed (`""` → `"`, outer wrapping quotes stripped)
* `&nbsp;` → space, `<br>` → removed
* HTML entities unescaped
* `<b>`, `<i>`, `<span style="font-variant: small-caps;">` tags PRESERVED
* Multi-word `<b>`/`<i>` spans normalized to per-word tags
* Spaces moved outside tags

### 2. Build a phrase cache from the placeholder splits

```bash
python3 tools/extract_phrases.py data/corinthians-parsed.json data/corinthians-phrases.json
```

Every verse will sit in the cache with a single-phrase placeholder, ready for the splitter.

### 3. Audit and split

Same as the fast path steps 3–5 — `evaluate_phrases.py` flags every long verse as a missing-split
case; `split_phrases.py` runs the splitter; `derive_structure.py` produces the committed file.

## File format

The intermediate parsed JSON (`corinthians-parsed.json`):

```json
{
  "year": 3,
  "books": ["1 Corinthians", "2 Corinthians"],
  "chapters": [{"book": "1 Corinthians", "number": 1, "start_verse": 1, "end_verse": 31}],
  "verses": [
    {
      "book": "1 Corinthians",
      "chapter": 1,
      "verse": 1,
      "text": "Paul, called to be an apostle of Jesus Christ through the will of God, and <b>Sosthenes</b> our brother,",
      "ftv": "Paul, called",
      "clubs": [300],
      "phrases": ["Paul, called to be an apostle of Jesus Christ", "through the will of God,", "and <b>Sosthenes</b> our brother,"]
    }
  ],
  "headings": [
    {
      "text": "Greeting",
      "book": "1 Corinthians",
      "start_chapter": 1, "start_verse": 1,
      "end_chapter": 1, "end_verse": 4
    }
  ]
}
```

The `text` field contains clean text with preserved HTML formatting:

* `<b>word</b>` — bold keyword
* `<i><b>word</b></i>` — bold italic keyword
* `L<span style="font-variant: small-caps;">ord</span>` — LORD small caps

The committed structural file (`corinthians.json`, produced by `derive_structure.py`) drops the
verse text and phrase strings — only `phraseWordCounts`, `annotations`, `ftvWordCount`, heading
ranges, and clubs remain. Consumers fetch the canonical NKJV text from api.bible at render time.

## Phrase quality checks

The deterministic checks in `tools/evaluate_phrases.py` codify the project's memorisation-quality
rules:

| Check                                         | Severity | What it catches                                             |
| --------------------------------------------- | -------- | ----------------------------------------------------------- |
| Rejoin invariant: `" ".join(phrases) == text` | blocker  | The LLM mangled text or dropped HTML                        |
| Empty / non-string phrase                     | blocker  | A phrase entry is `""` or not a string                      |
| HTML tag balance per phrase                   | blocker  | A split sliced a `<b>…</b>` open from its close             |
| Phrase > 12 words                             | high     | Run too long to chunk in working memory                     |
| Phrase < 3 words, mid-verse                   | high     | Stranded fragment like `"But one"` in 1 Cor 12:11           |
| Phrase < 3 words, at edge                     | medium   | Likely a stylistic intro/outro, often fine but worth a look |
| Single phrase, verse > 10 words               | high     | No split applied where one is needed                        |

The split prompt + LLM judge prompt are in `tools/phrase_splitter/prompts.py`. Iterate there; the
CLI and the phrase-splitter skill both import from that module.
