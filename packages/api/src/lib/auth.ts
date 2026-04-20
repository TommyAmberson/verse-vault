import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';

export interface AuthEnv {
  baseUrl: string;
  secret: string;
  webOrigin: string;
  googleClientId?: string;
  googleClientSecret?: string;
}

export function createAuth(db: DB, env: AuthEnv) {
  const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {};
  if (env.googleClientId && env.googleClientSecret) {
    socialProviders.google = {
      clientId: env.googleClientId,
      clientSecret: env.googleClientSecret,
    };
  }

  return betterAuth({
    baseURL: env.baseUrl,
    secret: env.secret,
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    trustedOrigins: [env.webOrigin],
    emailAndPassword: {
      enabled: true,
    },
    socialProviders,
    account: {
      accountLinking: {
        enabled: true,
        // Google verifies email addresses — safe to auto-link with the
        // matching email/password account.
        trustedProviders: ['google'],
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
