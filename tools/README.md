# Content Pipeline

Scripts for converting Bible content into verse-vault's intermediate JSON format.

## Pipeline overview

```
Anki export (.txt)
    │
    ▼
parse_anki.py ──→ parsed JSON (phrases = [whole verse])
    │
    ▼
prepare_batches.py ──→ batch-N-input.txt files + agent prompt template
    │
    ▼
LLM agents (Claude Code subagents) ──→ chunks-N.json files
    │
    ▼
validate_and_merge.py ──→ final JSON (phrases = [chunked phrases])
```

## Step-by-step

### 1. Parse the Anki export

```bash
python3 tools/parse_anki.py data/anki-export.txt data/corinthians-parsed.json --year 3-C
```

This parses the tab-separated Anki export, cleans HTML formatting, and produces
the intermediate JSON. Phrases are initially set to `[whole verse]` as placeholder.

**Text cleaning:**
- Anki CSV quote escaping removed (`""` → `"`, outer wrapping quotes stripped)
- `&nbsp;` → space, `<br>` → removed
- HTML entities unescaped
- `<b>`, `<i>`, `<span style="font-variant: small-caps;">` tags PRESERVED
- Multi-word `<b>`/`<i>` spans normalized to per-word tags
- Spaces moved outside tags

### 2. Prepare batch files for LLM chunking

```bash
python3 tools/prepare_batches.py data/corinthians-parsed.json --batch-size 50
```

Splits verses into `data/batch-N-input.txt` files (50 verses each, one per line)
and prints the agent prompt template.

### 3. Dispatch LLM agents

Use Claude Code to dispatch background Haiku agents. Each agent reads one batch
file, splits verses into phrases, and writes a `data/chunks-N.json` file.

**Agent prompt** (from prepare_batches.py output):

```
Read /path/to/data/batch-N-input.txt using the Read tool.
There are M lines, each a Bible verse that may contain HTML tags (<b>, <i>, <span>).

Split each line into memorization phrases (4-12 words). Rules:
- Break AFTER commas, semicolons, colons
- Break BEFORE conjunctions: and, but, for, that, who, which, or
- Short verses (< 8 words) stay as one phrase
- CRITICAL: Preserve ALL text exactly, including HTML tags. Do NOT modify
  any text, fix typos, or change quotes. Phrases joined with " " MUST
  exactly equal the original line.

Write ONLY valid JSON to /path/to/data/chunks-N.json — an array of M arrays of strings.
IMPORTANT: Some verses contain literal " (double quote) characters. In JSON
strings these MUST be escaped as \". For example: "He said: \"Come here.\""
Do NOT use Bash or Python. Use only Read and Write tools.
```

**Known issue:** LLM agents sometimes fail to escape `"` in JSON strings,
producing invalid JSON. The `validate_and_merge.py` script attempts to fix
this automatically. If a batch still has invalid JSON after the fix attempt,
manually fix the `chunks-N.json` file or re-dispatch that batch.

**Key settings for dispatch:**
- Model: `haiku` (cheaper, sufficient for this task)
- Run in background: `true`
- Some agents may fail due to permissions or content filtering — retry failed batches

### 4. Validate and merge

```bash
python3 tools/validate_and_merge.py data/corinthians-parsed.json data/corinthians.json
```

Validates that each verse's phrases rejoin to the original text exactly.
Reports:
- **Clean**: phrases match original ✓
- **Typo flagged**: LLM changed text slightly (likely corrected a typo in source)
- **Fallback**: too many changes, uses whole verse as single phrase

Typo-flagged verses show the original and suggested text so you can decide
which is correct.

## File format

The intermediate JSON (`corinthians.json`):

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
- `<b>word</b>` — bold keyword
- `<i><b>word</b></i>` — bold italic keyword
- `L<span style="font-variant: small-caps;">ord</span>` — LORD small caps
