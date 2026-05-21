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

export function createAuth(db: DB, env: AuthEnv) {
  const isProd = process.env.NODE_ENV === 'production';
  // In dev, trust any localhost port the thin client might land on (Vite
  // falls back through 5180/5181/… when ports collide). Production sticks
  // to the single configured origin.
  const trustedOrigins = isProd
    ? [env.webOrigin]
    : [env.webOrigin, 'http://localhost:5173', 'http://localhost:5180'];

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
    socialProviders: env.googleOAuth ? { google: env.googleOAuth } : {},
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
