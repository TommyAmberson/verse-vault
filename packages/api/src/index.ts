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

const { app, engines } = createApp({
  db: createDb(dbPath),
  authEnv,
  // BIBLE_API_KEY (or API_BIBLE_KEY) gates the api.bible cache. Without
  // it, GET /api/cards/:id returns the structural metadata only (composed:
  // null); the frontend can still render the prompt/grade UI.
  bibleApiKey: process.env.BIBLE_API_KEY ?? process.env.API_BIBLE_KEY,
  bibleId: process.env.NKJV_BIBLE_ID,
  // RENDER_DIALECT picks the spelling on rendered verse HTML. Accepts
  // ``american`` | ``british`` | ``canadian``; defaults to ``canadian``.
  // Any unrecognised value falls back to the default.
  dialect: ['american', 'british', 'canadian'].includes(process.env.RENDER_DIALECT ?? '')
    ? (process.env.RENDER_DIALECT as 'american' | 'british' | 'canadian')
    : 'canadian',
});

// Start the EngineStore idle reaper here, not in createApp — tests
// spin up many short-lived apps via createTestApp and don't want a
// 60 s setInterval accumulating per call.
engines.start();

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`verse-vault API listening on http://localhost:${info.port}`);
});
