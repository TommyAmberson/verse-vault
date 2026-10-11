import { getIp } from 'better-auth/api';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { account, session, user, verification } from './db/schema.js';
import { createAuth } from './lib/auth.js';
import { createEmailSender } from './lib/email.js';
import {
  type TestApp,
  TEST_AUTH_ENV,
  TEST_GOOGLE_ENV,
  createTestApp,
  createTestDb,
  createTestUser,
  emailLink,
  googleSignIn,
  signUpTestUser,
} from './test-utils.js';

/** POSTs a JSON body to a Better Auth route under `/api/auth`. */
function postAuth(test: TestApp, path: string, body: object, cookie?: string) {
  return test.app.request(`/api/auth/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

/** Follows a verification token the way the web page does, with whatever
 *  session `cookie` carries. */
function verify(test: TestApp, token: string, cookie?: string) {
  return test.app.request(`/api/auth/verify-email?token=${encodeURIComponent(token)}`, {
    headers: cookie ? { cookie } : {},
  });
}

function isVerified(test: TestApp, userId: string): boolean | undefined {
  return test.db.select().from(user).where(eq(user.id, userId)).get()?.emailVerified;
}

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

  const requestReset = (test: TestApp, email: string) =>
    postAuth(test, 'request-password-reset', { email });
  const resetPassword = (test: TestApp, token: string, newPassword: string) =>
    postAuth(test, 'reset-password', { token, newPassword });
  const signIn = (test: TestApp, email: string, password: string) =>
    postAuth(test, 'sign-in/email', { email, password });

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
    expect(isVerified(test, userId)).toBe(true);
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

  it("leaves other users' reset links working", async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    await signUpTestUser(test, 'first@example.com');
    await signUpTestUser(test, 'second@example.com');
    await requestReset(test, 'second@example.com');
    const second = resetToken(test);
    await requestReset(test, 'first@example.com');

    expect((await resetPassword(test, resetToken(test), 'firstReset123!')).status).toBe(200);
    expect((await resetPassword(test, second, 'secondReset123!')).status).toBe(200);
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


  it('emails a verification link at sign-up and lets the account sign in unverified', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { userId } = await signUpTestUser(test, 'new@example.com', 'newPassword123!');

    const sent = test.emails.filter((m) => m.subject === 'Verify your VerseVault email');
    expect(sent.map((m) => m.to)).toEqual(['new@example.com']);
    expect(isVerified(test, userId)).toBe(false);
    const signIn = await postAuth(test, 'sign-in/email', {
      email: 'new@example.com',
      password: 'newPassword123!',
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

    const res = await postAuth(
      test,
      'send-verification-email',
      { email: 'later@example.com' },
      cookie,
    );
    expect(res.status).toBe(200);
    expect(test.emails.map((m) => m.to)).toEqual(['later@example.com']);

    const token = new URL(emailLink(test.emails[0]!)).searchParams.get('token')!;
    expect((await verify(test, token, cookie)).status).toBe(200);
    expect((await sessionUser(test, cookie)).emailVerified).toBe(true);
  });
});

describe('email request throttling', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  const post = (test: TestApp, path: string, email: string) => postAuth(test, path, { email });

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

  it('caps requests that send email at 10 per IP per day', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const from = (ip: string, path: string, body: object) =>
      test.app.request(`/api/auth/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip },
        body: JSON.stringify(body),
      });
    const signUp = (ip: string, email: string) =>
      from(ip, 'sign-up/email', { email, password: 'superSecret123!', name: email });

    // Fresh addresses each time, so only the per-IP limit can refuse.
    for (let i = 0; i < 4; i++) {
      expect((await signUp('203.0.113.7', `new${i}@example.com`)).status).toBe(200);
    }
    for (let i = 0; i < 3; i++) {
      const email = `new${i}@example.com`;
      expect((await from('203.0.113.7', 'request-password-reset', { email })).status).toBe(200);
      expect((await from('203.0.113.7', 'send-verification-email', { email })).status).toBe(200);
    }
    const eleventh = await signUp('203.0.113.7', 'new9@example.com');
    expect(eleventh.status).toBe(429);
    expect(Number(eleventh.headers.get('Retry-After'))).toBeGreaterThan(3600);
    expect((await signUp('198.51.100.4', 'other@example.com')).status).toBe(200);
  });

  it('never counts a body too long to be an address', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const junk = `${'x'.repeat(300)}@example.com`;
    for (let i = 0; i < 4; i++) {
      expect((await post(test, 'request-password-reset', junk)).status).not.toBe(429);
    }
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

describe('Google sign-in onto a password account', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  async function verifiedPasswordUser(test: TestApp, email: string): Promise<string> {
    const { userId } = await signUpTestUser(test, email);
    test.db.update(user).set({ emailVerified: true }).where(eq(user.id, userId)).run();
    return userId;
  }

  function googleAccounts(test: TestApp, userId: string) {
    return test.db
      .select()
      .from(account)
      .all()
      .filter((a) => a.userId === userId && a.providerId === 'google');
  }

  it('links when Google reports the address verified', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    const userId = await verifiedPasswordUser(test, 'linked@example.com');

    const res = await googleSignIn(test, {
      sub: 'google-linked',
      email: 'linked@example.com',
      email_verified: true,
    });

    expect(res.headers.get('location')).toBe('http://localhost:5173/home');
    expect(googleAccounts(test, userId)).toHaveLength(1);
  });

  it("refuses when Google hasn't verified the address", async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    const userId = await verifiedPasswordUser(test, 'claimed@example.com');

    const res = await googleSignIn(test, {
      sub: 'google-unverified',
      email: 'claimed@example.com',
      email_verified: false,
    });

    expect(res.headers.get('location')).toContain('error=account_not_linked');
    expect(googleAccounts(test, userId)).toHaveLength(0);
  });
});
