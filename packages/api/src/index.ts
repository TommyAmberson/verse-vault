import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

const dbPath = process.env.DATABASE_PATH ?? resolve(__dirname, '../data/verse-vault.db');
runMigrations(dbPath);

const app = createApp({
  db: createDb(dbPath),
  auth: {
    baseUrl: process.env.API_BASE_URL ?? 'http://localhost:3000',
    secret: requireEnv('BETTER_AUTH_SECRET'),
    webOrigin: process.env.WEB_BASE_URL ?? 'http://localhost:5173',
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  },
});

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`verse-vault API listening on http://localhost:${info.port}`);
});
