import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';

function buildTestApp() {
  const path = `/tmp/vv-app-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  runMigrations(path);
  return createApp({
    db: createDb(path),
    auth: {
      baseUrl: 'http://localhost:3000',
      secret: 'test-secret-at-least-32-chars-long-xxxxxxxx',
      webOrigin: 'http://localhost:5173',
    },
  });
}

describe('health', () => {
  it('returns ok', async () => {
    const app = buildTestApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'ok' });
  });
});

describe('auth', () => {
  it('rejects /api/me without a session', async () => {
    const app = buildTestApp();
    const res = await app.request('/api/me');
    expect(res.status).toBe(401);
  });

  it('registers a user, logs in, and returns user info from /api/me', async () => {
    const app = buildTestApp();

    const signUpRes = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'alice@example.com',
        password: 'superSecret123!',
        name: 'Alice',
      }),
    });
    expect(signUpRes.status).toBe(200);

    // Better Auth sets the session via Set-Cookie on sign-up.
    const cookies = signUpRes.headers.get('set-cookie');
    expect(cookies).toBeTruthy();

    const meRes = await app.request('/api/me', {
      headers: { cookie: cookies! },
    });
    expect(meRes.status).toBe(200);
    const body = (await meRes.json()) as { user: { email: string; name: string } };
    expect(body.user.email).toBe('alice@example.com');
    expect(body.user.name).toBe('Alice');
  });
});
