# Contract: Reset Counter in the API

Additions to [`docs/server-api.md`](../../../docs/server-api.md). Header names are settled when the
docs are written; the shapes below are the contract.

## Request

Every API request from the web client carries a header with the counter the profile last saw. A
profile that has not seen one yet omits it.

## Response

Every response to an authenticated request carries a header with the account's current counter.

## Progress writes

`POST /api/sync/:materialId/events`, `POST /api/cards/review`, `POST /api/cards/memorize/graduate`,
`POST /api/cards/memorize/graduate-card`:

* counter header equal to the current counter, or absent (this release only): handled as today.
* counter header present and different: `409` with body
  `{ "error": "<message>", "code": "reset", "resetEpoch": <current> }`. Nothing is applied or held.

The check runs before any event is held and again under the deck's lock, before writing.

## Wipes

`DELETE /api/account/progress` and `DELETE /api/account/data`: the summary body gains `resetEpoch`,
the counter after the wipe.

## Unchanged

Import, export, settings, enrolment, and the read routes are not checked; they still carry the
response header.
