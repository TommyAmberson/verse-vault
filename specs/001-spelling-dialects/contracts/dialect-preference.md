# Contract: Dialect Preference

Two interfaces change. Both are additive except where noted.

## HTTP — per-reader preference

Mounted under the account surface (`app.route('/api', accountRoutes(...))`), alongside the existing
export/import/reset endpoints.

### `GET /api/preferences`

Returns the authenticated reader's preferences and the deployment default they fall back to.

```jsonc
// 200
{
  "dialect": "canadian",        // null when the reader has expressed no preference
  "effectiveDialect": "canadian", // what rendering will actually use
  "defaultDialect": "american"   // the deployment default, for UI copy
}
```

`effectiveDialect` is always one of the three values, never null. The client needs it on every boot
before it can render, so it MUST be cheap and MUST NOT require a second call.

* `401` when unauthenticated.

### `PUT /api/preferences`

```jsonc
// request
{ "dialect": "british" }   // or null to clear the preference
```

```jsonc
// 200 — same shape as GET
{ "dialect": "british", "effectiveDialect": "british", "defaultDialect": "american" }
```

* `400` when `dialect` is present but outside the enumeration. Note this differs from the read path,
  where an out-of-range **stored** value resolves to the default (FR-010): a write is a chance to
  reject bad input, a read is not a chance to fail the reader's session.
* `401` when unauthenticated.

**Idempotent.** Last write wins, no event-log involvement.

## Render payload — a removal

This is the breaking half, and it is a **removal of behaviour, not of shape**.

`GET /api/cards/:cardId`, `GET /api/materials/:id/renders`, and every other path through
`composeRender` currently return HTML with the deployment's dialect already applied. After Tranche B
they return the publisher's text, unsubstituted, always.

The JSON shape is unchanged — same fields, same types. What changes is the guarantee: **rendered
HTML from the API is the published text**. Substitution becomes the client's job.

Consequences for consumers:

* The web client MUST apply the reader's dialect before display. Until it does, readers see American
  spelling — a visible regression if the two halves ship apart, so they must land together.
* Any other consumer (tests, tooling, a future CLI) gets the published text and can apply a dialect
  or not. This is strictly more useful than the current behaviour, where the deployment's dialect
  was silently baked in.
* `packages/api/CHANGELOG.md` needs an entry. The payload shape is a de-facto contract with the
  client even though it carries no version of its own, and "same shape, different content guarantee"
  is exactly the kind of change a reader of the changelog needs told.

## Client-internal — substitution surface

Not an external contract, but the seam that makes FR-013 hold. Both the displayed text and the
recitation diff's canonical side MUST pass through one function with one dialect argument:

```ts
applyDialect(text: string, dialect: Dialect): string
```

The existing server-side implementation moves here essentially unchanged; its behaviour is already
correct (whole-word matching, capitalisation preservation, markup pass-through). What changes is
where it lives and that the dictionary is fetched rather than imported.

A single call site for both consumers is the requirement. Two call sites that happen to be passed
the same dialect would satisfy FR-013 today and break the first time someone changes one of them.
