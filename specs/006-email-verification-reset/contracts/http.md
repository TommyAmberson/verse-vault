# HTTP Contract

All Better Auth routes live under `/api/auth`. Bodies are JSON.

## Better Auth endpoints used (phase 1)

| Method and path                          | Body                                                                               | Response                                                                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/request-password-reset`  | `{ email }`                                                                        | 200 `{ status: true, message }` for every address; 429 when the address bucket is empty                                                     |
| `POST /api/auth/reset-password`          | `{ newPassword, token }`                                                           | 200 `{ status: true }`; 400 on a bad or used token                                                                                          |
| `POST /api/auth/send-verification-email` | `{ email }`                                                                        | 200 `{ status: true }` for every address; 429 as above                                                                                      |
| `GET /api/auth/verify-email`             | query `token`; called by the web page with the learner's session, no `callbackURL` | 200 when the session belongs to the token's user; 403 otherwise (nothing verified); 401 JSON `TOKEN_EXPIRED\|INVALID_TOKEN\|USER_NOT_FOUND` |
| `POST /api/auth/sign-up/email`           | unchanged                                                                          | unchanged; also sends the verification email                                                                                                |

Reset and verification emails link straight to the web app, `<web origin>/reset-password?token=` and
`<web origin>/verify-email?token=&email=`, built server-side from `WEB_BASE_URL` and the token
Better Auth hands the send callback. Whatever origin the requesting client has (a desktop client is
`tauri://…`), the link opens in the mail client's browser, so it must be the public web app. The
pages call `POST /reset-password` and `GET /verify-email` themselves.

Throttled responses: 429 with `Retry-After` (seconds) and Better Auth's error body,
`{ code: "TOO_MANY_REQUESTS", message }`.

## Google sign-in (phase 2a)

No endpoint changes. `GET /api/auth/callback/google` treats Google's address as verified only when
Google is authoritative for it: `email_verified` and an `@gmail.com` or `@googlemail.com` address,
or an `hd` claim (a Workspace account) (research D14). Otherwise it does not link into an existing
account, does not verify one, and a new user starts unverified. A refusal redirects with
`?error=account_not_linked` as before.

## Codes (phase 2b)

Better Auth's `emailOTP` plugin replaces the phase 1 link endpoints (research D15). Codes are 6
digits, last 10 minutes, and allow 3 wrong attempts.

| Method and path                                   | Body                                          | Response                                                                                                                                                                |
| ------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/email-otp/send-verification-otp`  | `{ email, type: "email-verification" }`       | 200 `{ success: true }` for every address; a code is sent only to an account's address; 429 when throttled                                                              |
| `POST /api/auth/email-otp/verify-email`           | `{ email, otp }`, with that account's session | 200 and verified; 403 for no session or another account's session (D12); 400 `INVALID_OTP` or `OTP_EXPIRED`; 403 `TOO_MANY_ATTEMPTS`                                    |
| `POST /api/auth/email-otp/request-password-reset` | `{ email }`                                   | 200 `{ success: true }` for every address; 429 when throttled                                                                                                           |
| `POST /api/auth/email-otp/reset-password`         | `{ email, otp, password }`                    | 200; the password is set (or created for a Google-only account), the address verified, every session ended; 400 `INVALID_OTP` or `OTP_EXPIRED`; 403 `TOO_MANY_ATTEMPTS` |
| `POST /api/auth/sign-up/email`                    | unchanged                                     | unchanged; also sends a verification code                                                                                                                               |

Refused with 404 so they cannot be used (outside this spec): `POST /api/auth/sign-in/email-otp`, the
send route with `type: "sign-in"` or `"change-email"`,
`POST /api/auth/email-otp/request-email-change`, `POST /api/auth/email-otp/change-email`, and the
deprecated `POST /api/auth/forget-password/email-otp`. The phase 1 link routes stop sending:
`POST /api/auth/request-password-reset` has no sender, and verification sends codes.

Code emails count towards the same limits as phase 1's emails: 3 per address per hour and 10 per IP
per day (FR-012).

## Better Auth endpoints used (phase 2b)

| Method and path                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/link-social`    | session required; `{ provider: "google", callbackURL }`; same address enforced. A non-authoritative Google account links only to a verified account; an unverified one comes back with `?error=verify_email_first` (research D17)                                                                                                                                                                                                                           |
| `GET /api/auth/callback/google` | when the address matches an existing account and Google verified it but isn't authoritative, sends a verification code to the address and redirects to the picker with `&code=1`; when Google is authoritative and the account is unverified, redirects to the choice as before. Both go to `<origin>/profiles?force=1&pending=<token>&email=<address>`, where `<origin>` is the origin of the client's `errorCallbackURL`, keeping the web app's base path |

## New routes (phase 2b)

Mounted with the account routes at `/api`.

| Method and path                     | Auth    | Body              | Effect                                                                                                                                                                 | Errors                                                                   |
| ----------------------------------- | ------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `POST /api/account/google/confirm`  | none    | `{ token, code }` | checks the emailed code for the pending record's address; then links Google to a verified account (`{ signIn: true }`) or marks the record proven (`{ choice: true }`) | 400 invalid or expired token or code; 403 too many attempts              |
| `POST /api/account/google/claim`    | session | `{ token }`       | consumes a proven pending record; links its Google `sub` to the session user if they match; verifies                                                                   | 400 invalid, expired, or unproven token; 403 another account's session   |
| `POST /api/account/google/takeover` | none    | `{ token }`       | consumes a proven pending record; deletes the password and every session; links Google; verifies                                                                       | 400 invalid, expired, or unproven token, or the user is already verified |

An invalid, used, expired, or unproven token returns the same 400 body in every case, revealing
nothing about the account (FR-021).

## New routes (phase 2c)

| Method and path            | Auth    | Body | Effect                                                                                                                                          | Errors |
| -------------------------- | ------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `DELETE /api/account/data` | session | none | full reset: progress plus enrolled decks, year settings, schedules, snapshots; returns the same summary shape as `DELETE /api/account/progress` | 401    |
