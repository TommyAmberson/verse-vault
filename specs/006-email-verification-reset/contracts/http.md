# HTTP Contract

All Better Auth routes live under `/api/auth`. Bodies are JSON.

## Better Auth endpoints used (phase 1)

| Method and path                          | Body                                                                               | Response                                                                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/request-password-reset`  | `{ email }`                                                                        | 200 `{ status: true, message }` for every address; 429 when the address bucket is empty                                                     |
| `POST /api/auth/reset-password`          | `{ newPassword, token }`                                                           | 200 `{ status: true }`; 400 on a bad or used token                                                                                          |
| `POST /api/auth/send-verification-email` | `{ email, callbackURL }`                                                           | 200 `{ status: true }` for every address; 429 as above                                                                                      |
| `GET /api/auth/verify-email`             | query `token`; called by the web page with the learner's session, no `callbackURL` | 200 when the session belongs to the token's user; 403 otherwise (nothing verified); 401 JSON `TOKEN_EXPIRED\|INVALID_TOKEN\|USER_NOT_FOUND` |
| `POST /api/auth/sign-up/email`           | unchanged                                                                          | unchanged; also sends the verification email                                                                                                |

Reset and verification emails link straight to the web app, `<web origin>/reset-password?token=` and
`<web origin>/verify-email?token=&email=`, built server-side from `WEB_BASE_URL` and the token
Better Auth hands the send callback. Whatever origin the requesting client has (a desktop client is
`tauri://…`), the link opens in the mail client's browser, so it must be the public web app. The
pages call `POST /reset-password` and `GET /verify-email` themselves.

Throttled responses: 429 with `Retry-After` (seconds) and Better Auth's error body,
`{ code: "TOO_MANY_REQUESTS", message }`.

## Better Auth endpoints used (phase 2)

| Method and path                 | Notes                                                                                                                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/link-social`    | session required; `{ provider: "google", callbackURL }`; same address enforced                                                                                                                |
| `GET /api/auth/callback/google` | on an unverified password account, and only when Google reports the address verified, now redirects to `<web origin>/profiles?force=1&pending=<token>` instead of `?error=account_not_linked` |

## New routes (phase 2)

Mounted with the account routes at `/api`.

| Method and path                     | Auth    | Body        | Effect                                                                                                                                          | Errors                                                                    |
| ----------------------------------- | ------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `POST /api/account/google/claim`    | session | `{ token }` | consumes the pending record; links its Google `sub` to the session user if the addresses match; verifies                                        | 400 invalid or expired token, 403 address mismatch                        |
| `POST /api/account/google/takeover` | none    | `{ token }` | consumes the pending record; deletes the password and every session; links Google; verifies                                                     | 400 invalid or expired token, or the user is already verified (same body) |
| `DELETE /api/account`               | session | none        | full reset: progress plus enrolled decks, year settings, schedules, snapshots; returns the same summary shape as `DELETE /api/account/progress` | 401                                                                       |

An invalid, used, or expired token returns the same 400 body in every case, revealing nothing about
the account (FR-021).
