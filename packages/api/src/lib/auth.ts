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

  return betterAuth({
    baseURL: env.baseUrl,
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
