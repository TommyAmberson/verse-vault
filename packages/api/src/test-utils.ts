import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import Database from 'better-sqlite3';
import { expect, vi } from 'vitest';

import { createApp } from './app.js';
import { type DB, createDb } from './db/client.js';
import type { AuthEnv } from './lib/auth.js';
import type { EmailMessage, SendEmail } from './lib/email.js';
import { user } from './db/schema.js';
import { MIGRATIONS_FOLDER, runMigrations } from './db/migrate.js';
import type { ObservabilityOptions } from './middleware/observability.js';

export const TEST_AUTH_ENV = {
  baseUrl: 'http://localhost:3000',
  secret: 'test-secret-at-least-32-chars-long-xxxxxxxx',
  webOrigin: 'http://localhost:5173',
};

export interface TestDb {
  db: DB;
  path: string;
  dir: string;
  cleanup: () => void;
}

/// Creates a fresh migrated SQLite database in its own temp directory.
/// The `dir` holds the main `.db`, the `-wal`, and the `-shm` sidecars;
/// `cleanup()` removes the whole dir.
export function createTestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), 'vv-test-'));
  const path = join(dir, 'test.db');
  runMigrations(path);
  return {
    db: createDb(path),
    path,
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export interface CreateTestAppOptions {
  /** Override observability middleware defaults. Useful for tests that
   *  need tight rate-limit tiers or want to capture logged JSON lines. */
  observability?: Partial<ObservabilityOptions>;
  /** Replaces the recording sender, e.g. to wrap a real sender with a
   *  stalled `fetch`. */
  sendEmail?: SendEmail;
  /** Merged over `TEST_AUTH_ENV`, e.g. to configure Google sign-in. */
  authEnv?: Partial<AuthEnv>;
}

/** Permissive rate-limit defaults so existing route tests (which fire
 *  many requests on the same `unknown` IP) don't accidentally hit
 *  production-scale caps. Tests that specifically exercise rate
 *  limiting pass `observability: { authedTier, ... }` to override.
 *
 *  `rateLimitUnknownIp: true` keeps the test-time bucketing behaviour
 *  pinned: tests rely on every request landing under `ip:unknown` so
 *  the limiter applies as a single bucket across the test. Production
 *  uses the same default (Cloudflare Tunnel injects CF-Connecting-IP,
 *  so a real request landing as `ip:unknown` is a misconfig). Only
 *  local-dev resolves to `false`, which is the regression we are
 *  fixing. */
const TEST_DEFAULT_OBSERVABILITY = {
  authedTier: { capacity: 100_000, refillPerSec: 100_000 / 60 },
  unauthedAuthTier: { capacity: 100_000, refillPerSec: 100_000 / 60 },
  rateLimitUnknownIp: true,
};

export function createTestApp(opts: CreateTestAppOptions = {}) {
  const test = createTestDb();
  // Pull `engines` so tests can clear() / inspect it if they want.
  // We deliberately don't call `engines.start()` here — tests run in
  // milliseconds and have no use for the 60 s idle reaper.
  // Every email an auth flow sends lands here, so a test can read its code.
  const emails: EmailMessage[] = [];
  const { app, engines } = createApp({
    db: test.db,
    authEnv: { ...TEST_AUTH_ENV, ...opts.authEnv },
    observability: { ...TEST_DEFAULT_OBSERVABILITY, ...opts.observability },
    sendEmail: opts.sendEmail ?? ((message) => emails.push(message)),
  });
  return { app, engines, emails, ...test };
}

/** The code in the newest email recorded for `to`. */
export function emailCode(emails: EmailMessage[], to: string): string {
  const message = emails.filter((m) => m.to === to).at(-1);
  const match = /\b\d{6}\b/.exec(message?.text ?? '');
  if (!match) throw new Error(`no code emailed to ${to}`);
  return match[0];
}

export type TestApp = ReturnType<typeof createTestApp>;

/** Inserts a bare user row for tests that don't need a Better Auth session. */
export function createTestUser(db: DB, userId: string): void {
  const now = Math.floor(Date.now() / 1000);
  db.insert(user)
    .values({
      id: userId,
      email: `${userId}@example.com`,
      name: userId,
      emailVerified: false,
      createdAt: new Date(now * 1000),
      updatedAt: new Date(now * 1000),
    })
    .run();
}

/** Re-applies one migration's SQL against an already-migrated test DB.
 *
 *  `createTestDb` runs every migration before a test can seed anything,
 *  so a data migration can't be exercised by inserting pre-migration
 *  rows and calling the migrator again — drizzle has already recorded it
 *  as applied. Replaying the file directly runs the same statements the
 *  deploy-time pass runs, against rows they can actually see.
 *
 *  Splits on `--> statement-breakpoint` and prepares each chunk
 *  separately, which is what drizzle's migrator does. `exec` would run
 *  the whole file regardless, so a migration that forgot its breakpoints
 *  would pass here and then die at boot on better-sqlite3's
 *  one-statement-per-prepare rule — see CLAUDE.md's gotchas. */
export function applyMigration(dbPath: string, tag: string): void {
  const sql = readFileSync(resolve(MIGRATIONS_FOLDER, `${tag}.sql`), 'utf8');
  const sqlite = new Database(dbPath);
  try {
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim() === '') continue;
      sqlite.prepare(statement).run();
    }
  } finally {
    sqlite.close();
  }
}

/** Creates a user via Better Auth's email sign-up and returns the session cookie + user id. */
export async function signUpTestUser(
  test: TestApp,
  email: string,
  password = 'superSecret123!',
): Promise<{ cookie: string; userId: string }> {
  const res = await test.app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: email }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.get('set-cookie')!;
  const row = test.db
    .select()
    .from(user)
    .all()
    .find((r) => r.email === email);
  if (!row) throw new Error(`user not found: ${email}`);
  return { cookie, userId: row.id };
}

/** Hits POST /api/materials/enroll and asserts success. */
export async function enrollViaApi(
  test: TestApp,
  cookie: string,
  materialId: string,
  clubTier: number | null = null,
): Promise<void> {
  const res = await test.app.request('/api/materials/enroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ materialId, clubTier }),
  });
  expect(res.status).toBe(200);
}

/** Google sign-in config for `createTestApp({ authEnv })`. */
export const TEST_GOOGLE_ENV: Partial<AuthEnv> = {
  googleOAuth: { clientId: 'test-client-id', clientSecret: 'test-client-secret' },
};

export interface GoogleProfile {
  sub: string;
  email: string;
  email_verified: boolean;
  /** The Workspace domain, for a Google Workspace account. */
  hd?: string;
}

/** Runs a Google sign-in through Better Auth's real callback, with only
 *  Google's token endpoint stubbed: it answers with an unsigned ID token
 *  for `profile`, which Better Auth decodes without verifying. Returns the
 *  callback's response, whose `Location` says where the browser lands.
 *  `errorCallbackURL` is the page the client started from. */
export async function googleSignIn(
  test: TestApp,
  profile: GoogleProfile,
  errorCallbackURL = 'http://localhost:5173/profiles',
): Promise<Response> {
  const start = await test.app.request('/api/auth/sign-in/social', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'google',
      callbackURL: 'http://localhost:5173/home',
      errorCallbackURL,
    }),
  });
  return googleCallback(test, start, profile);
}

/** Connects Google to the account `cookie` is signed in to, through
 *  `/link-social` and the same stubbed callback as `googleSignIn`. */
export async function googleLink(
  test: TestApp,
  cookie: string,
  profile: GoogleProfile,
): Promise<Response> {
  const start = await test.app.request('/api/auth/link-social', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ provider: 'google', callbackURL: 'http://localhost:5173/settings' }),
  });
  return googleCallback(test, start, profile);
}

async function googleCallback(
  test: TestApp,
  start: Response,
  profile: GoogleProfile,
): Promise<Response> {
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get('state')!;
  const stateCookie = start.headers.get('set-cookie') ?? '';

  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const idToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode(profile)}.`;
  const realFetch = globalThis.fetch;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const href = input instanceof Request ? input.url : String(input);
    if (href.startsWith('https://oauth2.googleapis.com/token')) {
      return Response.json({
        access_token: 'test-access-token',
        id_token: idToken,
        token_type: 'Bearer',
        expires_in: 3600,
      });
    }
    return realFetch(input, init);
  });
  try {
    return await test.app.request(`/api/auth/callback/google?code=test-code&state=${state}`, {
      headers: { cookie: stateCookie },
    });
  } finally {
    spy.mockRestore();
  }
}

/** The pending Google token a refused callback set in its cookie; the
 *  redirect itself carries none (research D16). */
export function pendingTokenFrom(res: Response): string | null {
  return /better-auth\.pending_google=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? null;
}

/** The cookie that carries a pending Google token back to the API. */
export const pendingCookie = (token: string) => `better-auth.pending_google=${token}`;
