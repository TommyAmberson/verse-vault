# Phase 1 Data Model: Spelling Dialects

## Entities

### Dialect

A closed enumeration of three values. Not stored as free text anywhere.

| Value      | Meaning                                                    | Dictionary     |
| ---------- | ---------------------------------------------------------- | -------------- |
| `american` | Source dialect. No substitution. **The default** (FR-009). | none           |
| `british`  | VarCon `B` column.                                         | 15,747 entries |
| `canadian` | VarCon `C` column.                                         | 4,864 entries  |

**Validation**: any value outside the enumeration resolves to the **deployment default** rather than
erroring — which is `american` out of the box but is whatever `RENDER_DIALECT` names. Do not
hard-code the fallback to `american`; resolution takes the default as a parameter (FR-010). This
applies to the stored preference, the deployment default, and anything read from configuration.

**Note on authorship**: the project defines the enumeration but not its contents. Which words differ
and how is VarCon's judgement — see the Assumptions section of `spec.md`.

### UserPreference

New per-user row. Keyed on `user_id` alone, deliberately not on `(user_id, material_id)` — see
research decision R3.

| Field        | Type     | Notes                                                                  |
| ------------ | -------- | ---------------------------------------------------------------------- |
| `user_id`    | text, PK | FK to `user.id`, cascade on delete                                     |
| `dialect`    | text     | One of the enumeration. Nullable: null means "no preference expressed" |
| `updated_at` | integer  | Unix seconds                                                           |

**Absent row and null `dialect` both mean the same thing**: the reader has expressed no preference
and receives the deployment default. This matters for FR-009 — a reader who has never visited
settings must get the source dialect, and the cheapest way to guarantee that is for "no row" and
"the source dialect" to produce identical behaviour.

**State transitions**: none. Last write wins; there is no event-log replay for preferences, matching
how `material_schedules` already behaves.

### DeploymentDefault

Not a stored entity — configuration. `RENDER_DIALECT` continues to exist but narrows in meaning: it
no longer selects the dialect for everyone, it selects what a reader with no preference gets. Its
default becomes `american` (FR-009).

### ModificationDisclosure

Derived, never stored. A function of the reader's effective dialect.

| Effective dialect      | Disclosure                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `american`             | none — the publisher's attribution stands alone (FR-015)                                                                                        |
| `british` / `canadian` | attribution plus a notice naming the dialect, attributing the change to the product, and stating the text is not the published wording (FR-014) |

Because it derives from the _reader's_ effective dialect rather than the deployment's, two readers
viewing the same verse can require different disclosures (FR-016).

## Derived data

### Substitution dictionaries

Built from `varcon@1.0.1`'s `A.json` at build time, one artifact per target dialect.

**Derivation rules** (unchanged from current behaviour, relocated):

* Key on the lowercased American form.
* Drop entries whose American key contains a space — whole-word matching cannot express them
  (FR-006).
* Drop entries whose target variant contains a space, for the same reason.
* Drop entries whose target variant equals the American form — no substitution to make.

**Consumed by**: the client only, after research decision R1. Loaded on demand for the reader's
dialect; `american` loads nothing.

## Relationships

```text
user ──1:0..1── user_preferences
                      │
                      │ dialect (nullable)
                      ▼
              effective dialect ──── falls back to ───▶ RENDER_DIALECT (default: american)
                      │
        ┌─────────────┴─────────────┐
        ▼                           ▼
  substitution                 disclosure
  (client, at display)         (client, with attribution)
        │                           │
        └──── both derive from one value, so FR-013 and FR-016 hold together
```

## What does not change

`user_year_settings` is untouched. Cached render payloads are untouched — same shape, same 30-day
TTL, same one-entry-per-card keying. That is the point of moving substitution after the cache rather
than before it.
