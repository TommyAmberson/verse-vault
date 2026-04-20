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
  return betterAuth({
    baseURL: env.baseUrl,
    secret: env.secret,
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    trustedOrigins: [env.webOrigin],
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
