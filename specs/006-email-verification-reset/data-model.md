# Data Model: Email Verification and Password Reset

No migration. Every server-side record below already exists in `packages/api/src/db/schema.ts`.

## Server

### user (Better Auth)

* `emailVerified` (boolean, default false). Set true by: following a verification link while signed
  in to that account; completing a password reset (FR-006, via `onPasswordReset`); linking a Google
  account with the same address (phase 2, via the account-create hook); a takeover (phase 2). Google
  sign-ups start true. Never set back to false by this feature.

### account (Better Auth)

* A row with `providerId = 'credential'` holds the password. Reset creates it for a Google-only user
  (first password) or updates it. A takeover deletes it (phase 2).
* A row with `providerId = 'google'`, `accountId = <Google sub>` is created by sign-up, by
  `linkSocial`, or by the claim and takeover routes (phase 2).

### session (Better Auth)

* All of a user's rows are deleted on password reset (FR-005) and on takeover (FR-020).

### verification (Better Auth)

| identifier               | value                              | expires    | written by                        | consumed by                       |
| ------------------------ | ---------------------------------- | ---------- | --------------------------------- | --------------------------------- |
| `reset-password:<token>` | user id                            | 1 hour     | Better Auth on reset request      | reset; others deleted on reset    |
| `pending-google:<token>` | JSON: user id, Google `sub`, email | 10 minutes | the callback after hook (phase 2) | the claim or takeover route, once |

Verification links are stateless signed tokens (24 hours) and leave no row.

## In memory

* Per-address bucket: a `TokenBucketStore` keyed by the lowercased address, capacity 3, refilling 3
  per hour. Lost on restart.

## Web (cache)

* Profile registry row (`apps/web/src/lib/engine/registry.ts`) gains optional `emailVerified`.
  Written on sign-in and device-session reconciliation from the session user. Absent means unknown
  and shows no badge.

## State transitions

```text
password account:  unverified --verify link | reset | matching Google link | takeover--> verified
takeover:          unverified + password + sessions --"That's not me"--> verified, no password,
                   no sessions, Google linked
```
