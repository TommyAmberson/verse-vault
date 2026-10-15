# Data Model: Email Verification and Password Reset

No migration. Every server-side record below already exists in `packages/api/src/db/schema.ts`.

## Server

### user (Better Auth)

* `emailVerified` (boolean, default false). Set true by:
  * entering a verification code in that account's session (phase 2b; a link in phase 1);
  * completing a password reset (FR-006; the plugin in 2b, `onPasswordReset` in phase 1);
  * connecting a Google account with the same address once the inbox is proven (2b);
  * a takeover (2b).
* Google sign-ups start true only when Google is authoritative for the address (phase 2a, research
  D14), false otherwise. Existing flags are left alone. Never set back to false by this feature.

### account (Better Auth)

* A row with `providerId = 'credential'` holds the password. Reset creates it for a Google-only user
  (first password) or updates it. A takeover deletes it (phase 2).
* A row with `providerId = 'google'`, `accountId = <Google sub>` is created by sign-up, by
  `linkSocial`, or by the claim and takeover routes (phase 2).

### session (Better Auth)

* All of a user's rows are deleted on password reset (FR-005) and on takeover (FR-020).

### verification (Better Auth)

| identifier                         | value                                                                    | expires    | written by                                      | consumed by                                                            |
| ---------------------------------- | ------------------------------------------------------------------------ | ---------- | ----------------------------------------------- | ---------------------------------------------------------------------- |
| `email-verification-otp-<address>` | hashed code and wrong-attempt count                                      | 10 minutes | the email-code plugin (2b); replaced on resend  | verify by code, or the Google confirm route (2b); 3 wrong tries end it |
| `forget-password-otp-<address>`    | hashed code and wrong-attempt count                                      | 10 minutes | the email-code plugin (2b); replaced on resend  | reset by code (2b); 3 wrong tries end it                               |
| `pending-google:<token>`           | JSON: user id, Google `sub`, email, whether the inbox is proven yet (2b) | 10 minutes | the callback after hook                         | confirm marks it proven; claim or takeover consume it once             |
| `reset-password:<token>`           | user id                                                                  | 1 hour     | phase 1 only (links); no longer written from 2b | phase 1 reset                                                          |

## In memory

Codes are not held in memory; the plugin keeps them in `verification`.

* Per-address bucket: a `TokenBucketStore` keyed by the lowercased address, capacity 3, refilling 3
  per hour. Lost on restart.

## Web (cache)

* Profile registry row (`apps/web/src/lib/engine/registry.ts`) gains optional `emailVerified`.
  Written on sign-in and device-session reconciliation from the session user. Absent means unknown
  and shows no badge.

## State transitions

```text
password account:  unverified --verify code | reset | Google link with inbox proof | takeover--> verified
Google sign-in onto an existing account:
  authoritative ------------------------------> linked (verified account) | choice (unverified)
  not authoritative --emailed code confirmed--> linked (verified account) | choice (unverified)
  Google never verified the address ----------> refused
takeover:          unverified + password + sessions --"That's not me"--> verified, no password,
                   no sessions, Google linked
```
