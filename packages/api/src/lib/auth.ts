import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { multiSession } from 'better-auth/plugins';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';

export interface AuthEnv {
  baseUrl: string;
  secret: string;
  webOrigin: string;
  googleOAuth?: { clientId: string; clientSecret: string };
}

/** Origins served inside the Tauri desktop shell — one per webview
 *  family. WebKit (macOS / Linux) loads the frontend at `tauri://`;
 *  Edge WebView2 (Windows) loads it at `https://tauri.localhost`
 *  because `useHttpsScheme: true` in `apps/web/src-tauri/tauri.conf.json`
 *  is what makes Secure session cookies eligible to be sent. Both
 *  values must be allowlisted on every server surface that gates by
 *  origin (CORS, Better Auth `trustedOrigins`). */
export const TAURI_ORIGINS = ['tauri://localhost', 'https://tauri.localhost'] as const;

export function createAuth(db: DB, env: AuthEnv) {
  const isProd = process.env.NODE_ENV === 'production';
  // Browsers send Origin headers as scheme+host+port only — never a path.
  // env.webOrigin may include a subpath (production used
  // `https://www.versevault.ca/vv` before moving to the root), but matching
  // against trustedOrigins needs the bare origin. Strip the path here once and reuse below.
  const webOrigin = new URL(env.webOrigin).origin;

  // In dev, trust any localhost port the thin client might land on (Vite
  // falls back through 5180/5181/… when ports collide). Production sticks
  // to the configured web origin plus the Tauri origins — the desktop
  // shell reuses the same API so the user-facing surface is identical.
  const trustedOrigins = isProd
    ? [webOrigin, ...TAURI_ORIGINS]
    : [webOrigin, 'http://localhost:5173', 'http://localhost:5180', ...TAURI_ORIGINS];

  // Better Auth derives its request-matching basePath from
  // `new URL(baseURL).pathname` — so any path component in env.baseUrl
  // (a subpath deploy, as production's `/vv` was) becomes part of what
  // Better Auth expects every request URL to start with. The API always
  // receives requests at `/api/auth/*`: vv-router forwards `/api/*` with the
  // path unchanged (and used to strip `/vv`). Pass just the origin so the match path
  // stays empty and `/api/auth/*` is matched directly. We still keep
  // env.baseUrl as the source of truth for the public-facing URL (used
  // elsewhere for things like OAuth-flow URL construction).
  const betterAuthBaseURL = new URL(env.baseUrl).origin;

  return betterAuth({
    baseURL: betterAuthBaseURL,
    secret: env.secret,
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    trustedOrigins,
    // Better Auth's default error page is `${baseURL}/error`, a bare page
    // on the API rather than the app. Send any OAuth error the client didn't
    // give its own errorCallbackURL for to the profile picker instead, which
    // shows it. force=1 keeps the
    // router guard from forwarding a signed-in user off the picker (and
    // dropping `?error=`); Better Auth appends `&error=<code>`.
    onAPIError: { errorURL: `${env.webOrigin.replace(/\/$/, '')}/profiles?force=1` },
    emailAndPassword: { enabled: true },
    socialProviders: env.googleOAuth
      ? {
          google: {
            ...env.googleOAuth,
            // Pin the redirect URI to the public API URL (env.baseUrl) rather
            // than Better Auth's derived one, which is built from the
            // origin-only baseURL above and would drop any subpath. It must
            // match a URI registered in the Google console exactly. Tauri-shell OAuth is expected to reuse
            // this same URI (the flow lands on the API, which bounces to
            // the in-app `callbackURL`) but isn't smoke-tested yet — see
            // the Known limitations entry in apps/web/CHANGELOG.md.
            redirectURI: `${env.baseUrl}/api/auth/callback/google`,
          },
        }
      : {},
    account: {
      accountLinking: {
        // Trusting Google skips only the provider-side email check.
        // better-auth >= 1.6.11 still refuses to auto-link onto a local
        // account whose own email is unverified (`requireLocalEmailVerified`,
        // default true), which blocks pre-registering a victim's email with a
        // password (GHSA-g38m-r43w-p2q7). Email/password accounts are never
        // verified here, so Google sign-in no longer merges into one; don't
        // turn that off without adding email verification first.
        enabled: true,
        trustedProviders: ['google'],
      },
    },
    // Multi-session lets the device hold cookies for several signed-in
    // accounts at once. Each new sign-in is stacked alongside any
    // existing session cookies rather than replacing them; the picker
    // uses `multiSession.{listDeviceSessions,setActive,revoke}` to
    // swap between accounts and to sign out a single profile without
    // disturbing the others. Schema-compatible — no new tables.
    plugins: [multiSession()],
  });
}

export type Auth = ReturnType<typeof createAuth>;
