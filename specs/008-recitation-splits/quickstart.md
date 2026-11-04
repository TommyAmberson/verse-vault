# Quickstart: Recitation-Based Phrase Splits

Validation guide for the feature. Run from the repository root.

## Prerequisites

* Python 3. The stdlib path needs nothing else.
* The api.bible cache at `packages/api/data/verse-vault.db` (gitignored). A fresh worktree lacks it;
  link the canonical clone's copy (link the file, not the directory: git ignores the directory only
  when it is a real one) so every command and the calibration test find it:

  ```bash
  mkdir -p packages/api/data
  ln -s ~/Code/verse-vault/packages/api/data/verse-vault.db packages/api/data/
  ```

* Optional parse signal: spaCy and its small English model in a virtual environment for the tools
  (instructions in `tools/README.md`). Run the audit with that environment's `python` to enable it.

## 1. Unit tests

```bash
python3 -m unittest tools/test_phrase_splitter.py
```

Expected: all pass. The calibration test skips with a reason when the cache is missing.

## 2. Calibration (User Story 3)

```bash
python3 tools/evaluate_phrases.py --calibrate --show-text
```

Expected:

* exit 0; every reference entry validates;
* every `agreed` entry whose agreed split differs from the deck is `ok` (SC-001);
* every `FALSE ALARM` line names the signals that fired (SC-002).

Run once with the stdlib interpreter and once with the spaCy environment; the report's `parse` field
says which ran.

## 3. Audit (User Story 1)

```bash
python3 tools/evaluate_phrases.py data/4-john.json --refs "John 5:16" --all
python3 tools/evaluate_phrases.py data/6-ot-survey.json --refs "Judges 2:16, Isaiah 55:10" --all
```

Expected: John 5:16 shows no signal pushing "For this reason" to merge; Judges 2:16 shows a long run
with a `relative` pause point before "who delivered them"; Isaiah 55:10 shows `lost_line_break` on
"That it may give seed to the sower And bread to the eater,".

Time the full audit over every phrase-split deck (SC-005):

```bash
time for d in 3-corinthians 4-john 5-hp 6-ot-survey 7-rj 8-luke; do
  python3 tools/evaluate_phrases.py data/$d.json --out /dev/null --all
done
```

## 4. Prompts (User Story 2)

```bash
python3 tools/split_phrases.py --deck data/4-john.json print-prompt --refs "John 5:29"
```

Expected: the verse line reads "and come forth—those who have done good, …" with the dash, and the
prompt states the recitation criteria.

Apply a dash-bearing reply without changing counts (SC-006):

```bash
echo '[{"ref":"John 5:29","phrases":["and come forth—","those who have done good, to the resurrection of life,","and those who have done evil, to the resurrection of condemnation."]}]' \
  | python3 tools/split_phrases.py --deck data/4-john.json apply --input - --dry-run
```

Expected: applied with counts summing to the canonical total; the deck file is unchanged.

## 5. LLM measurements (SC-003, SC-004)

Before the prompt rewrite lands, render prompts for the reference verses with `--no-current` and
dispatch the splitter (Haiku and Sonnet) as the phrase-splitter skill describes; count exact matches
with the agreed splits. Repeat after the rewrite: the new count must be higher.

For each verse, build a candidate set from its `agreed`, `acceptable` and `rejected` splits, emit
rating prompts and dispatch the rater, then emit selection prompts and dispatch the selector. With
the churn guard off, the pick is never a rejected split and is the agreed or an acceptable split for
every verse marked agreed (SC-004); with it on and the agreed split as current, the pick is the
current split (SC-007). Run each role with Haiku and with Sonnet. Record the results in the pull
request body.
