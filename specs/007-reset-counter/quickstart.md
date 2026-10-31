# Quickstart: Reset Counter

Prerequisites: `pnpm install`, the WASM build from `CONTRIBUTING.md`, then `pnpm dev` for the API
and web.

## Automated

```sh
pnpm --filter @verse-vault/api test        # refusal, queued-write refusal, wipe moves the counter
pnpm --filter @verse-vault/web test        # catch-up and notice rules
pnpm --filter @verse-vault/web run type-check && pnpm --filter @verse-vault/web exec vite build
```

## In the browser

1. Sign in to the same account in two browsers, A and B. Enrol a deck and review a few cards in
   both.
2. Take B offline (devtools) and review a few more cards there.
3. In A, run Reset account (or Delete all progress). A shows its usual banner and no "reset on
   another device" notice.
4. Bring B back online. B shows the notice once and shows the account as A left it; its offline
   reviews are gone.
5. In either browser, enrol the deck again: it shows no progress.
6. Review in B: the reviews are accepted.

## Older client

Send a review upload without the counter header (for example with `curl` and a session cookie): it
is accepted in this release.
