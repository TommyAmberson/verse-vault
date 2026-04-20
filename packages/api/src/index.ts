import { resolve } from 'node:path';

import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

// Validate env before touching the filesystem — if secrets are missing we
// don't want to have already opened a DB / run a migration.
const authEnv = {
  baseUrl: process.env.API_BASE_URL ?? 'http://localhost:3000',
  secret: requireEnv('BETTER_AUTH_SECRET'),
  webOrigin: process.env.WEB_BASE_URL ?? 'http://localhost:5173',
  googleOAuth:
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? {
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        }
      : undefined,
};

const dbPath = process.env.DATABASE_PATH ?? resolve(import.meta.dirname, '../data/verse-vault.db');
runMigrations(dbPath);

const app = createApp({ db: createDb(dbPath), authEnv });

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`verse-vault API listening on http://localhost:${info.port}`);
});
