import { getIp } from 'better-auth/api';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { account, session, user, verification } from './db/schema.js';
import { createAuth } from './lib/auth.js';
import { createEmailSender } from './lib/email.js';
import {
  type TestApp,
  TEST_AUTH_ENV,
  createTestApp,
  createTestDb,
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

describe('email verification', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  const VERIFY_PAGE = 'http://localhost:5173/verify-email';

  /** The token in the newest verification email, which opens the web app's
   *  verification page rather than the API. */
  function verifyToken(test: TestApp): string {
    const message = test.emails.filter((m) => m.subject === 'Verify your VerseVault email').at(-1);
    const link = new URL(emailLink(message!));
    expect(`${link.origin}${link.pathname}`).toBe(VERIFY_PAGE);
    expect(link.searchParams.get('email')).toBe(message!.to);
    return link.searchParams.get('token')!;
  }

  function verify(test: TestApp, token: string, cookie?: string) {
    return test.app.request(`/api/auth/verify-email?token=${encodeURIComponent(token)}`, {
      headers: cookie ? { cookie } : {},
    });
  }

  function isVerified(test: TestApp, userId: string): boolean | undefined {
    return test.db.select().from(user).where(eq(user.id, userId)).get()?.emailVerified;
  }

  it('emails a verification link at sign-up and lets the account sign in unverified', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { userId } = await signUpTestUser(test, 'new@example.com', 'newPassword123!');

    const sent = test.emails.filter((m) => m.subject === 'Verify your VerseVault email');
    expect(sent.map((m) => m.to)).toEqual(['new@example.com']);
    expect(isVerified(test, userId)).toBe(false);
    const signIn = await test.app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com', password: 'newPassword123!' }),
    });
    expect(signIn.status).toBe(200);
  });

  it("verifies with the account's own session and creates no session", async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie, userId } = await signUpTestUser(test, 'own@example.com');
    const sessionsBefore = test.db.select().from(session).all().length;

    const res = await verify(test, verifyToken(test), cookie);

    expect(res.status).toBe(200);
    expect(isVerified(test, userId)).toBe(true);
    expect(test.db.select().from(session).all()).toHaveLength(sessionsBefore);
  });

  it('refuses a link opened without a session, so a pre-registered address stays unverified', async () => {
    // The attack this guards against: someone signs up with another
    // person's address; if that person clicks the genuine email while
    // signed out, the account must not become verified with the other
    // person's password still on it.
    const test = createTestApp();
    cleanup = test.cleanup;
    const { userId } = await signUpTestUser(test, 'victim@example.com');

    const res = await verify(test, verifyToken(test));

    expect(res.status).toBe(403);
    expect(isVerified(test, userId)).toBe(false);
  });

  it("refuses a link opened with another account's session", async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { userId } = await signUpTestUser(test, 'target@example.com');
    const token = verifyToken(test);
    const other = await signUpTestUser(test, 'other@example.com');

    const res = await verify(test, token, other.cookie);

    expect(res.status).toBe(403);
    expect(isVerified(test, userId)).toBe(false);
  });

  it('rejects a malformed token', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'bad@example.com');
    const res = await verify(test, 'not-a-token', cookie);
    expect(res.status).toBe(401);
  });

  it('accepts the same link twice from the right session', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'twice-verify@example.com');
    const token = verifyToken(test);
    expect((await verify(test, token, cookie)).status).toBe(200);
    expect((await verify(test, token, cookie)).status).toBe(200);
  });
});

describe('verifying an existing account', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  async function sessionUser(test: TestApp, cookie: string) {
    const res = await test.app.request('/api/auth/get-session', { headers: { cookie } });
    return ((await res.json()) as { user: { emailVerified: boolean } }).user;
  }

  it('sends a fresh link to a signed-in learner and reports the status on the session', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'later@example.com');
    test.emails.length = 0;
    expect((await sessionUser(test, cookie)).emailVerified).toBe(false);

    const res = await test.app.request('/api/auth/send-verification-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ email: 'later@example.com' }),
    });
    expect(res.status).toBe(200);
    expect(test.emails.map((m) => m.to)).toEqual(['later@example.com']);

    const token = new URL(emailLink(test.emails[0]!)).searchParams.get('token')!;
    const verified = await test.app.request(`/api/auth/verify-email?token=${token}`, {
      headers: { cookie },
    });
    expect(verified.status).toBe(200);
    expect((await sessionUser(test, cookie)).emailVerified).toBe(true);
  });
});

describe('email request throttling', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  function post(test: TestApp, path: string, email: string) {
    return test.app.request(`/api/auth/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
  }

  it('refuses a fourth request for one address within the hour, account or not', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    await signUpTestUser(test, 'busy@example.com');

    for (const email of ['busy@example.com', 'ghost@example.com']) {
      expect((await post(test, 'request-password-reset', email)).status).toBe(200);
      expect((await post(test, 'send-verification-email', email)).status).toBe(200);
      expect((await post(test, 'request-password-reset', email.toUpperCase())).status).toBe(200);
      const fourth = await post(test, 'request-password-reset', email);
      expect(fourth.status).toBe(429);
      expect(Number(fourth.headers.get('Retry-After'))).toBeGreaterThan(0);
    }
    expect((await post(test, 'request-password-reset', 'fresh@example.com')).status).toBe(200);
  });

  it("reads the client IP from Cloudflare's header for Better Auth's own limits", () => {
    // Requests reach the API through Cloudflare Tunnel with CF-Connecting-IP
    // and no X-Forwarded-For; read only Better Auth's default header and
    // every production client would share one rate-limit bucket.
    const test = createTestDb();
    cleanup = test.cleanup;
    const auth = createAuth(test.db, TEST_AUTH_ENV, () => {});
    const request = new Request('http://localhost:3000/api/auth/request-password-reset', {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    });
    expect(getIp(request, auth.options)).toBe('203.0.113.7');
  });
});
