# Third-party content and scope of LICENSE

`LICENSE` (MIT) covers the verse-vault source code only. The scripture text the app displays is a
separate copyrighted work delivered through a third-party API and is not licensed under MIT.

## Scripture text — NKJV

> Scripture quotations marked NKJV are taken from the New King James Version®. Copyright © 1982 by
> Thomas Nelson. Used by permission. All rights reserved.

NKJV text is accessed through [API.Bible](https://api.bible). Use of the API and its content is
subject to the [API.Bible Terms of Service](https://api.bible/terms-and-conditions) — in particular
the [Acceptable Use](https://api.bible/terms-and-conditions#acceptable_use) clause and the
[licensing & access overview](https://docs.api.bible/quick-start/licensing-and-access).

The constraints verse-vault honours:

* Cached scripture content is refreshed within 30 days of fetch (server-side `ApibibleCache` and any
  client-side render cache both enforce this TTL).
* Cached content is not used to train generative AI or LLMs.
* Text content is not converted to derivative formats (e.g. text → audio).
* No systematic bulk extraction of scripture content into separate databases. Server-side rendering
  is one card at a time; client-side caching is opt-in per device (the "Available offline" toggle in
  the deck settings) and is cleared when the user signs out.

Per the Starter-plan attribution requirement, the in-app footer links to https://api.bible and the
NKJV citation above is shown on the About / Stats page.
