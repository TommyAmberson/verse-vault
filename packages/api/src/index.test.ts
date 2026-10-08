import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { account, user, verification } from './db/schema.js';
import { createEmailSender } from './lib/email.js';
import {
  type TestApp,
  createTestApp,
  createTestUser,
  emailLink,
  signUpTestUser,
} from './test-utils.js';

describe('health', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('returns ok', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const res = await test.app.request('/health');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'ok' });
  });
});

describe('auth', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('rejects /api/me without a session', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const res = await test.app.request('/api/me');
    expect(res.status).toBe(401);
  });

  it('registers a user, logs in, and returns user info from /api/me', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;

    const signUpRes = await test.app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'alice@example.com',
        password: 'superSecret123!',
        name: 'Alice',
      }),
    });
    expect(signUpRes.status).toBe(200);

    const cookies = signUpRes.headers.get('set-cookie');
    expect(cookies).toBeTruthy();

    const meRes = await test.app.request('/api/me', {
      headers: { cookie: cookies! },
    });
    expect(meRes.status).toBe(200);
    const body = (await meRes.json()) as { user: { email: string; name: string } };
    expect(body.user.email).toBe('alice@example.com');
    expect(body.user.name).toBe('Alice');
  });
});

describe('password reset', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  const REDIRECT = 'http://localhost:5173/reset-password';

  function requestReset(test: TestApp, email: string) {
    return test.app.request('/api/auth/request-password-reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
  }

  function resetPassword(test: TestApp, token: string, newPassword: string) {
    return test.app.request('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, newPassword }),
    });
  }

  function signIn(test: TestApp, email: string, password: string) {
    return test.app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  }

  /** The token in the reset link, which opens the web app's reset page. */
  function resetToken(test: TestApp): string {
    const link = new URL(emailLink(test.emails.at(-1)!));
    expect(`${link.origin}${link.pathname}`).toBe(REDIRECT);
    return link.searchParams.get('token')!;
  }

  it('emails a link for an existing address and answers an unknown one identically', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    await signUpTestUser(test, 'reset@example.com');
    const before = test.emails.length;

    const known = await requestReset(test, 'reset@example.com');
    const unknown = await requestReset(test, 'nobody@example.com');

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual(await known.json());
    const sent = test.emails.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('reset@example.com');
    expect(sent[0]!.subject).toBe('Reset your VerseVault password');
  });

  it('answers without waiting for the email provider', async () => {
    const stalled = createEmailSender('re_key', () => {}, () => new Promise<Response>(() => {}));
    const test = createTestApp({ sendEmail: stalled });
    cleanup = test.cleanup;
    await signUpTestUser(test, 'stall@example.com');
    const res = await requestReset(test, 'stall@example.com');
    expect(res.status).toBe(200);
  });

  it('sets the new password, ends every session, and verifies the address', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie, userId } = await signUpTestUser(test, 'change@example.com', 'oldPassword123!');
    await requestReset(test, 'change@example.com');

    const res = await resetPassword(test, resetToken(test), 'newPassword123!');
    expect(res.status).toBe(200);

    expect((await signIn(test, 'change@example.com', 'oldPassword123!')).status).toBe(401);
    expect((await signIn(test, 'change@example.com', 'newPassword123!')).status).toBe(200);
    expect((await test.app.request('/api/me', { headers: { cookie } })).status).toBe(401);
    const row = test.db.select().from(user).where(eq(user.id, userId)).get();
    expect(row?.emailVerified).toBe(true);
  });

  it('rejects an older link once a newer one is used, and a link used twice', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    await signUpTestUser(test, 'twice@example.com');
    await requestReset(test, 'twice@example.com');
    const older = resetToken(test);
    await requestReset(test, 'twice@example.com');
    const newer = resetToken(test);

    expect((await resetPassword(test, newer, 'firstReset123!')).status).toBe(200);
    expect((await resetPassword(test, newer, 'secondReset123!')).status).toBe(400);
    expect((await resetPassword(test, older, 'thirdReset123!')).status).toBe(400);
  });

  it('rejects an expired link', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    await signUpTestUser(test, 'late@example.com');
    await requestReset(test, 'late@example.com');
    test.db.update(verification).set({ expiresAt: new Date(Date.now() - 1000) }).run();
    expect((await resetPassword(test, resetToken(test), 'tooLate123!')).status).toBe(400);
  });

  it('lets a Google-only account set its first password', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    createTestUser(test.db, 'google-only');
    const now = new Date();
    test.db
      .insert(account)
      .values({
        id: 'acc-google',
        userId: 'google-only',
        accountId: 'google-sub-1',
        providerId: 'google',
        createdAt: now,
        updatedAt: now,
      })
      .run();

    await requestReset(test, 'google-only@example.com');
    expect(test.emails.at(-1)?.to).toBe('google-only@example.com');
    expect((await resetPassword(test, resetToken(test), 'firstPassword123!')).status).toBe(200);
    expect((await signIn(test, 'google-only@example.com', 'firstPassword123!')).status).toBe(200);
  });
});
