# Prompt design notes

The active split prompt lives in `/home/amberson/Code/verse-vault/tools/phrase_splitter/prompts.py`
as `SPLIT_PROMPT` and the `format_split_prompt(verse_text, current_split, signals)` helper. Keep
iterating in that file so the skill and the CLI stay in sync. This document captures _why_ the
prompt is shaped the way it is, so future edits move it forward rather than recreating past
mistakes.

## Core moves in the current draft

1. **Goal-first framing.** Open with "you're splitting a verse for memorisation; chunks should feel
   like natural pauses." This sets the judgement frame before any rule list. Goal framing
   outperforms rule enumeration for fluent text tasks.
2. **Soft rules with cues, not absolutes.** The prompt lists clause/ parallel/connector cues but
   reminds the model that connectors only count when they start a new thought, not when they're
   glued to a list. This avoids the previous "break before every `and`" failure mode.
3. **Negative examples integrated.** `"But one"` is called out by name as a stranded-fragment
   failure. This anchors the model on the biggest practical class of errors.
4. **HTML preservation as a contract.** Tagged spans are treated as indivisible units; the prompt
   frames the rejoin invariant explicitly.
5. **Few-shot examples cover the main shapes.**
   * The intro-connector case (1 Cor 1:1) — break after the head clause.
   * The whole-verse case (1 Cor 4:20) — short enough to stay one phrase.
   * The parallel-structure case (1 Cor 1:26) — siblings, not lumps.
   * The "stranded fragment fixed" case (1 Cor 12:11) — the corrected form, so the model has a
     positive target.
   * The clause-with-relative-pronoun case (1 Cor 5:5) — internal break on `that` to keep each half
     under the soft ceiling.
6. **JSON-only reply on one line.** Reduces post-processing failure; the apply step parses the
   response directly.

## What's not in the current prompt (deliberately)

* **No hard "max 8 words per phrase".** That was the old rule and it forced mechanical breaks on
  short verses. The soft 3–12 ceiling lets the model honour idioms.
* **No batch mode.** Per-verse calls give the model full attention. The previous batch-of-50
  approach was the main source of mangled outputs (lost punctuation, dropped tags).
* **No instruction to "fix typos".** The previous prompt accidentally invited corrections, which
  broke the rejoin invariant. Now the preservation contract is explicit.

## Known weak spots to watch for in iteration

* **Single-word opener policy.** The current examples include splits with `"Therefore,"` joined to
  the next clause (combining intro + rest into one phrase). The deck cache often has them as
  separate phrases (`"Therefore," / "my beloved," / ...`) which can read as bad fragments. The
  prompt currently leans toward merging; the evaluator treats both as acceptable. If users push
  back, tighten the prompt by adding a "prefer to merge short intro fragments" rule with an example.
* **Long lists.** Verses with extended enumerations (1 Cor 13:4-7 love list) need each item as a
  phrase. The parallel-structure example covers a 3-element case; if the model lumps longer lists,
  add a 5+ element example.
* **Quoted speech.** Verses containing `"He said: \"..."` round-trip fine through JSON escaping but
  the prompt doesn't explicitly say "preserve quotation marks". So far no failures observed; add an
  example if a future iteration introduces them.

## How to iterate

1. Run the evaluator → pick 5–10 verses where the prompt produces an awkward split.
2. Edit `tools/phrase_splitter/prompts.py`. Prefer adding/swapping a few-shot example over adding a
   new rule.
3. Re-run those verses through the prompt (manually, or via the skill-creator eval loop in
   `phrase-splitter-workspace/`).
4. If the regression catches the targeted failure without breaking verses that were passing, commit
   the prompt change with a message describing the failure class. Otherwise back it out.

## Prior iterations (running log)

* **v0** (legacy draft) — first cohesive prompt with 5 examples, goal-first framing, and the rejoin
  invariant as a contract. Replaces the legacy bullet-list rules from the old `prepare_batches.py`
  prompt. Known wins: gets 1 Cor 12:11, 1 Cor 1:26, 1 Cor 11:14 right when called per-verse. Known
  unknowns: behaviour on long lists, on quoted speech, on multi-clause verses with three or more
  natural breaks.

* **v1 — stand-alone framing rewrite.** The v0 prompt leaned on a numbered-rule list that read as
  hard constraints; this caused two correlated failures during a full John re-split: (a)
  subject/verb severance and dangling NPs when the model mechanically applied "break before `and` /
  `but`", and (b) restrictive-relative severance ("...nothing was made / that was made.") when the
  model treated the relative as a new clause. v1 reframes the prompt around the _stand-alone
  principle_: every phrase should land as a self-contained unit; there are no rules, only signals.
  Heuristics demote from rules to "this often indicates…". The prompt now also has three
  placeholders (`{verse_text}`, `{current_split}`, `{signals_block}`) and a **stability clause**
  under the rendered current split: "if the current split already passes the stand-alone test,
  return it verbatim; change boundaries only when the new split is _clearly_ better, not merely
  defensible." This folds the previous LLM-judge step into the splitter — judging and splitting now
  happen in one call with the same context. The numeric `composite_signal_score` in `features.py`
  replaces the categorical `high`/`medium` severity, and the auditor surfaces signal-rich verses
  without prescribing a fix.
