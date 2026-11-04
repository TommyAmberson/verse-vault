# Contract: Reference Set and Calibration

## File

A JSON array committed beside the tooling. Word counts only, never verse text (see research R8).

```json
[
  {
    "ref": "John 5:7",
    "deck": "data/4-john.json",
    "agreed": [5, 17, 5, 5],
    "confidence": "agreed",
    "note": "cut where you'd pause reciting; the comma before 'another' is a real breath",
    "rejected": [
      { "counts": [5, 5, 12, 10], "reason": "'Sir, I have no man' severs 'man' from 'to put me'" }
    ]
  }
]
```

Entries are converted from the reviewed splits in the maintainer's working notes.

An entry may also carry `acceptable`: other splits the maintainer would accept, as
`{counts, reason}`. A deck already at an acceptable split counts as kept, and a splitter proposal
matching one counts as a match; the selector test checks that `rejected` splits are never picked.

`confidence`:

* `agreed`: scored by calibration and used for SC-001, SC-003, SC-004.
* `weak`: scored, reported separately (a miss is information, not a failure).
* `unresolved`: validated only; excluded from scores.

## Calibration mode of the audit CLI

```bash
python3 tools/evaluate_phrases.py --calibrate [--db PATH] [--min-score X] [--show-text]
```

* Reads the reference set and, per entry, its deck and the api.bible cache.
* Fails (exit 1) when any entry's `agreed` or `rejected` counts no longer sum to the canonical token
  count, naming the reference.
* Prints one line per entry: reference, `changed` or `kept`, score, `ok` or `MISS` / `FALSE ALARM`,
  and the signals that fired. `--show-text` renders the deck split and the agreed split from the
  cache for reading.
* Ends with the totals from [data-model.md](../data-model.md#calibration-result). Exit status is 0
  whenever validation passes; whether the scores meet SC-001 is the test's job.

## Unit test

The tooling's test suite runs calibration when the cache is reachable and skips with a reason
otherwise. It asserts SC-001 (every `agreed` `changed` entry is flagged at the default threshold)
and SC-006 (every entry validates).
