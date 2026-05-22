import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';

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
  // env.webOrigin may include a subpath in prod (e.g.
  // `https://www.versevault.ca/vv`), but matching against trustedOrigins
  // needs the bare origin. Strip the path here once and reuse below.
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
  // (e.g. `/vv` in prod, where the SPA is mounted under a subpath) becomes
  // part of what Better Auth expects every request URL to start with. The
  // API actually receives requests at `/api/auth/*` because vv-router
  // strips `/vv` before forwarding. Pass just the origin so the match path
  // stays empty and `/api/auth/*` is matched directly. We still keep
  // env.baseUrl as the source of truth for the public-facing URL (used
  // elsewhere for things like OAuth-flow URL construction).
  const betterAuthBaseURL = new URL(env.baseUrl).origin;

  return betterAuth({
    baseURL: betterAuthBaseURL,
    secret: env.secret,
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    trustedOrigins,
    emailAndPassword: { enabled: true },
    socialProviders: env.googleOAuth
      ? {
          google: {
            ...env.googleOAuth,
            // Better Auth's auto-generated redirect URI is
            // `${baseURL}/callback/google`. With our stripped origin-only
            // baseURL that resolves to https://<origin>/callback/google —
            // wrong on two fronts: it's missing `/api/auth/`, and the path
            // would hit the sibling qzr-api Worker, not vv-router → API.
            // Pin the redirect URI to a URL that goes through vv-router and
            // matches the value provision.sh tells the user to register in
            // the Google OAuth client. The Tauri shell reuses this same URI
            // — Google redirects back to the API, which sets the session
            // cookie and bounces to the `callbackURL` the client supplied.
            redirectURI: `${env.baseUrl}/api/auth/callback/google`,
          },
        }
      : {},
    account: {
      accountLinking: {
        // Google verifies email addresses — safe to auto-link with the
        // matching email/password account.
        enabled: true,
        trustedProviders: ['google'],
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
