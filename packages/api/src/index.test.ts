import { getIp } from 'better-auth/api';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { account, session, user, verification } from './db/schema.js';
import { createAuth } from './lib/auth.js';
import { createEmailSender } from './lib/email.js';
import {
  type GoogleProfile,
  type TestApp,
  TEST_AUTH_ENV,
  TEST_GOOGLE_ENV,
  createTestApp,
  createTestDb,
  createTestUser,
  emailCode,
  googleLink,
  googleSignIn,
  pendingCookie,
  pendingTokenFrom,
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

/** A code that isn't `code`. */
const wrongFor = (code: string) => (code === '000000' ? '111111' : '000000');

function isVerified(test: TestApp, userId: string): boolean | undefined {
  return test.db.select().from(user).where(eq(user.id, userId)).get()?.emailVerified;
}

/** The account's sign-in methods: `credential` for a password, `google`. */
function providers(test: TestApp, userId: string): string[] {
  return test.db
    .select()
    .from(account)
    .where(eq(account.userId, userId))
    .all()
    .map((a) => a.providerId);
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

  const requestReset = (test: TestApp, email: string) =>
    postAuth(test, 'email-otp/request-password-reset', { email });
  const resetPassword = (test: TestApp, email: string, otp: string, password: string) =>
    postAuth(test, 'email-otp/reset-password', { email, otp, password });
  const signIn = (test: TestApp, email: string, password: string) =>
    postAuth(test, 'sign-in/email', { email, password });

  it('emails a code for an existing address and answers an unknown one identically', async () => {
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
    expect(sent[0]!.subject).toBe('Your VerseVault reset code');
    expect(emailCode(sent, 'reset@example.com')).toMatch(/^\d{6}$/);
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

    const code = emailCode(test.emails, 'change@example.com');
    const res = await resetPassword(test, 'change@example.com', code, 'newPassword123!');
    expect(res.status).toBe(200);

    expect((await signIn(test, 'change@example.com', 'oldPassword123!')).status).toBe(401);
    expect((await signIn(test, 'change@example.com', 'newPassword123!')).status).toBe(200);
    expect((await test.app.request('/api/me', { headers: { cookie } })).status).toBe(401);
    expect(isVerified(test, userId)).toBe(true);
  });

  it('accepts only the newest code, and only once', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    await signUpTestUser(test, 'twice@example.com');
    await requestReset(test, 'twice@example.com');
    const older = emailCode(test.emails, 'twice@example.com');
    await requestReset(test, 'twice@example.com');
    const newer = emailCode(test.emails, 'twice@example.com');

    // Two six-digit codes can match by chance; then "older" is the newer one.
    if (older !== newer) {
      expect((await resetPassword(test, 'twice@example.com', older, 'olderReset123!')).status)
        .toBe(400);
    }
    expect((await resetPassword(test, 'twice@example.com', newer, 'firstReset123!')).status)
      .toBe(200);
    expect((await resetPassword(test, 'twice@example.com', newer, 'secondReset123!')).status)
      .toBe(400);
  });

  it('ends the code after three wrong tries', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    await signUpTestUser(test, 'guess@example.com', 'oldPassword123!');
    await requestReset(test, 'guess@example.com');
    const code = emailCode(test.emails, 'guess@example.com');
    const wrong = wrongFor(code);

    for (let i = 0; i < 3; i++) {
      const res = await resetPassword(test, 'guess@example.com', wrong, 'guessed123!');
      expect(res.status).toBe(400);
    }
    const late = await resetPassword(test, 'guess@example.com', code, 'newPassword123!');
    expect(late.status).toBe(403);
    expect((await signIn(test, 'guess@example.com', 'oldPassword123!')).status).toBe(200);
  });

  it("leaves other users' reset codes working", async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    await signUpTestUser(test, 'first@example.com');
    await signUpTestUser(test, 'second@example.com');
    await requestReset(test, 'second@example.com');
    await requestReset(test, 'first@example.com');

    const first = emailCode(test.emails, 'first@example.com');
    const second = emailCode(test.emails, 'second@example.com');
    expect((await resetPassword(test, 'first@example.com', first, 'firstReset123!')).status)
      .toBe(200);
    expect((await resetPassword(test, 'second@example.com', second, 'secondReset123!')).status)
      .toBe(200);
  });

  it('rejects an expired code', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    await signUpTestUser(test, 'late@example.com');
    await requestReset(test, 'late@example.com');
    test.db.update(verification).set({ expiresAt: new Date(Date.now() - 1000) }).run();
    const code = emailCode(test.emails, 'late@example.com');
    expect((await resetPassword(test, 'late@example.com', code, 'tooLate123!')).status).toBe(400);
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
    const code = emailCode(test.emails, 'google-only@example.com');
    const res = await resetPassword(test, 'google-only@example.com', code, 'firstPassword123!');
    expect(res.status).toBe(200);
    expect((await signIn(test, 'google-only@example.com', 'firstPassword123!')).status).toBe(200);
  });
});

describe('email verification', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  const verify = (test: TestApp, email: string, otp: string, cookie?: string) =>
    postAuth(test, 'email-otp/verify-email', { email, otp }, cookie);

  it('emails a code at sign-up and lets the account sign in unverified', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { userId } = await signUpTestUser(test, 'new@example.com', 'newPassword123!');

    const sent = test.emails.filter((m) => m.subject === 'Your VerseVault code');
    expect(sent.map((m) => m.to)).toEqual(['new@example.com']);
    expect(emailCode(sent, 'new@example.com')).toMatch(/^\d{6}$/);
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

    const res = await verify(test, 'own@example.com', emailCode(test.emails, 'own@example.com'), cookie);

    expect(res.status).toBe(200);
    expect(isVerified(test, userId)).toBe(true);
    expect(test.db.select().from(session).all()).toHaveLength(sessionsBefore);
  });

  it('refuses a code entered without a session, so a pre-registered address stays unverified', async () => {
    // The attack this guards against: someone signs up with another
    // person's address; if that person enters the genuine code while
    // signed out, the account must not become verified with the other
    // person's password still on it.
    const test = createTestApp();
    cleanup = test.cleanup;
    const { userId } = await signUpTestUser(test, 'victim@example.com');

    const res = await verify(test, 'victim@example.com', emailCode(test.emails, 'victim@example.com'));

    expect(res.status).toBe(403);
    expect(isVerified(test, userId)).toBe(false);
  });

  it("refuses a code entered with another account's session", async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { userId } = await signUpTestUser(test, 'target@example.com');
    const code = emailCode(test.emails, 'target@example.com');
    const other = await signUpTestUser(test, 'other@example.com');

    const res = await verify(test, 'target@example.com', code, other.cookie);

    expect(res.status).toBe(403);
    expect(isVerified(test, userId)).toBe(false);
  });

  it("doesn't count a signed-out guess, refusing it before comparing", async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie, userId } = await signUpTestUser(test, 'guarded@example.com');
    const code = emailCode(test.emails, 'guarded@example.com');

    for (let i = 0; i < 3; i++) {
      expect((await verify(test, 'guarded@example.com', wrongFor(code))).status).toBe(403);
    }
    expect((await verify(test, 'guarded@example.com', code, cookie)).status).toBe(200);
    expect(isVerified(test, userId)).toBe(true);
  });

  it('refuses a wrong code, and a code used once already', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'bad@example.com');
    const code = emailCode(test.emails, 'bad@example.com');
    const wrong = wrongFor(code);

    expect((await verify(test, 'bad@example.com', wrong, cookie)).status).toBe(400);
    expect((await verify(test, 'bad@example.com', code, cookie)).status).toBe(200);
    expect((await verify(test, 'bad@example.com', code, cookie)).status).toBe(400);
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

  const sendCode = (test: TestApp, email: string, cookie?: string) =>
    postAuth(test, 'email-otp/send-verification-otp', { email, type: 'email-verification' }, cookie);

  it('sends a fresh code to a signed-in learner and reports the status on the session', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'later@example.com');
    test.emails.length = 0;
    expect((await sessionUser(test, cookie)).emailVerified).toBe(false);

    const res = await sendCode(test, 'later@example.com', cookie);
    expect(res.status).toBe(200);
    expect(test.emails.map((m) => m.to)).toEqual(['later@example.com']);

    const code = emailCode(test.emails, 'later@example.com');
    const verified = await postAuth(
      test,
      'email-otp/verify-email',
      { email: 'later@example.com', otp: code },
      cookie,
    );
    expect(verified.status).toBe(200);
    expect((await sessionUser(test, cookie)).emailVerified).toBe(true);
  });

  it('replaces the older code with the newer one', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'resend@example.com');
    const older = emailCode(test.emails, 'resend@example.com');
    await sendCode(test, 'resend@example.com', cookie);
    const newer = emailCode(test.emails, 'resend@example.com');
    const verify = (otp: string) =>
      postAuth(test, 'email-otp/verify-email', { email: 'resend@example.com', otp }, cookie);

    if (older !== newer) expect((await verify(older)).status).toBe(400);
    expect((await verify(newer)).status).toBe(200);
  });

  it('answers an unknown address the same way and sends nothing', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    await signUpTestUser(test, 'known@example.com');
    test.emails.length = 0;

    const known = await sendCode(test, 'known@example.com');
    const unknown = await sendCode(test, 'unknown@example.com');
    expect(await unknown.json()).toEqual(await known.json());
    expect(test.emails.map((m) => m.to)).toEqual(['known@example.com']);
  });
});

describe('refused code routes', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('refuses the plugin routes this app does not use, and sends nothing', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    await signUpTestUser(test, 'routes@example.com');
    test.emails.length = 0;
    const email = 'routes@example.com';

    const refused: [string, object][] = [
      ['sign-in/email-otp', { email, otp: '123456' }],
      ['email-otp/send-verification-otp', { email, type: 'sign-in' }],
      ['email-otp/send-verification-otp', { email, type: 'change-email' }],
      ['email-otp/request-email-change', { newEmail: 'new@example.com' }],
      ['email-otp/change-email', { newEmail: 'new@example.com', otp: '123456' }],
      ['forget-password/email-otp', { email }],
      ['email-otp/check-verification-otp', { email, type: 'forget-password', otp: '123456' }],
    ];
    for (const [path, body] of refused) {
      const res = await postAuth(test, path, body);
      expect(res.status, path).toBe(404);
    }
    expect(test.emails).toHaveLength(0);
  });

  it("refuses phase 1's link routes, so links in older emails stop working", async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const email = 'old-link@example.com';
    await signUpTestUser(test, email);

    expect((await postAuth(test, 'request-password-reset', { email })).status).toBe(404);
    const reset = await postAuth(test, 'reset-password', { token: 'old', newPassword: 'x'.repeat(12) });
    expect(reset.status).toBe(404);
    expect((await test.app.request('/api/auth/verify-email?token=old')).status).toBe(404);
  });
});

describe('email request throttling', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  const RESET = 'email-otp/request-password-reset';
  const SEND_CODE = 'email-otp/send-verification-otp';
  const post = (test: TestApp, path: string, email: string) =>
    postAuth(test, path, path === SEND_CODE ? { email, type: 'email-verification' } : { email });

  it('refuses a fourth request for one address within the hour, account or not', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    await signUpTestUser(test, 'busy@example.com');

    for (const email of ['busy@example.com', 'ghost@example.com']) {
      expect((await post(test, RESET, email)).status).toBe(200);
      expect((await post(test, SEND_CODE, email)).status).toBe(200);
      expect((await post(test, RESET, email.toUpperCase())).status).toBe(200);
      const fourth = await post(test, RESET, email);
      expect(fourth.status).toBe(429);
      expect(Number(fourth.headers.get('Retry-After'))).toBeGreaterThan(0);
    }
    expect((await post(test, RESET, 'fresh@example.com')).status).toBe(200);
  });

  it('sends at most 10 emails per IP per day, never refusing a sign-up', async () => {
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

    expect((await signUp('203.0.113.7', 'new0@example.com')).status).toBe(200);
    // A sign-up that creates no account sends nothing and costs nothing.
    expect((await signUp('203.0.113.7', 'new0@example.com')).status).not.toBe(200);
    expect((await from('203.0.113.7', RESET, { email: 'new0@example.com' })).status)
      .toBe(200);
    for (let i = 1; i < 9; i++) {
      expect((await signUp('203.0.113.7', `new${i}@example.com`)).status).toBe(200);
    }
    // That's 10 emails. Past the limit, sign-up still works but sends no email.
    expect((await signUp('203.0.113.7', 'late@example.com')).status).toBe(200);
    expect(test.emails).toHaveLength(10);
    expect(test.emails.some((m) => m.to === 'late@example.com')).toBe(false);

    const reset = await from('203.0.113.7', RESET, { email: 'new1@example.com' });
    expect(reset.status).toBe(429);
    expect(Number(reset.headers.get('Retry-After'))).toBeGreaterThan(3600);
    expect((await signUp('198.51.100.4', 'other@example.com')).status).toBe(200);
    expect(test.emails.at(-1)?.to).toBe('other@example.com');
  });

  it("doesn't charge the network for requests the address limit refuses", async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const reset = (email: string) =>
      test.app.request(`/api/auth/${RESET}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '203.0.113.7' },
        body: JSON.stringify({ email }),
      });
    for (let i = 0; i < 10; i++) await reset('impatient@example.com');
    // Only 3 of those counted for the network, so 7 more addresses fit.
    for (let i = 0; i < 7; i++) {
      expect((await reset(`other${i}@example.com`)).status).toBe(200);
    }
    expect((await reset('one-too-many@example.com')).status).toBe(429);
  });

  it('never counts a body too long to be an address', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const junk = `${'x'.repeat(300)}@example.com`;
    for (let i = 0; i < 4; i++) {
      expect((await post(test, RESET, junk)).status).not.toBe(429);
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

  function userRow(test: TestApp, email: string) {
    return test.db.select().from(user).all().find((u) => u.email === email);
  }

  // Google speaks for an address only when it hosts the mail: a Gmail
  // address, or a Workspace account.
  it('links a Gmail account into a verified account', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;

    // Older UK and German Gmail accounts still use googlemail.com.
    for (const email of ['learner@gmail.com', 'learner@googlemail.com']) {
      const userId = await verifiedPasswordUser(test, email);
      const res = await googleSignIn(test, { sub: `google-${email}`, email, email_verified: true });
      expect(res.headers.get('location')).toBe('http://localhost:5173/home');
      expect(googleAccounts(test, userId)).toHaveLength(1);
    }
  });

  it('links a Workspace account whose domain matches the address', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    const userId = await verifiedPasswordUser(test, 'linked@example.com');

    const res = await googleSignIn(test, {
      sub: 'google-linked',
      email: 'linked@example.com',
      email_verified: true,
      hd: 'example.com',
    });

    expect(res.headers.get('location')).toBe('http://localhost:5173/home');
    expect(providers(test, userId)).toContain('google');
  });

  it("refuses when Google hasn't verified the address", async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    const userId = await verifiedPasswordUser(test, 'claimed@example.com');

    const res = await googleSignIn(test, {
      sub: 'google-unverified',
      email: 'claimed@example.com',
      email_verified: false,
      hd: 'example.com',
    });

    expect(res.headers.get('location')).toContain('error=account_not_linked');
    expect(providers(test, userId)).not.toContain('google');
  });

  // Google checked an outside address only once, when the Google account
  // was made; whoever holds it now may not hold the inbox.
  it("doesn't link an outside address Google reports verified, asking for a code instead", async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    const userId = await verifiedPasswordUser(test, 'owner@example.com');

    const res = await googleSignIn(test, {
      sub: 'google-owner',
      email: 'owner@example.com',
      email_verified: true,
    });

    expect(new URL(res.headers.get('location')!).searchParams.get('code')).toBe('1');
    expect(googleAccounts(test, userId)).toHaveLength(0);
  });

  // A Workspace organization can give users addresses on any domain it has
  // proven it owns; `hd` names only its primary domain.
  it('links a Workspace account on a secondary domain', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    const userId = await verifiedPasswordUser(test, 'alias@example.com');

    const res = await googleSignIn(test, {
      sub: 'google-alias',
      email: 'alias@example.com',
      email_verified: true,
      hd: 'corp.example',
    });

    expect(res.headers.get('location')).toBe('http://localhost:5173/home');
    expect(googleAccounts(test, userId)).toHaveLength(1);
  });

  it('counts a new outside-address Google sign-up towards the daily email limit', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    const outside = (n: number) => ({
      sub: `g-outside-${n}`,
      email: `outside${n}@example.com`,
      email_verified: true,
    });

    // Unverified, so it gets the verification email like a password sign-up.
    await googleSignIn(test, outside(0));
    expect(test.emails.map((m) => m.to)).toEqual(['outside0@example.com']);

    for (let i = 1; i < 10; i++) await signUpTestUser(test, `fill${i}@example.com`);
    const res = await googleSignIn(test, outside(1));
    expect(res.headers.get('location')).toBe('http://localhost:5173/home');
    expect(test.emails.some((m) => m.to === 'outside1@example.com')).toBe(false);
  });

  it('starts a new Google sign-up verified only where Google is authoritative', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;

    for (const profile of [
      { sub: 'g-new-gmail', email: 'new@gmail.com', email_verified: true },
      { sub: 'g-new-ws', email: 'new@example.com', email_verified: true, hd: 'example.com' },
      { sub: 'g-new-outside', email: 'new@outside.example', email_verified: true },
    ]) {
      const res = await googleSignIn(test, profile);
      expect(res.headers.get('location')).toBe('http://localhost:5173/home');
    }
    expect(userRow(test, 'new@gmail.com')?.emailVerified).toBe(true);
    expect(userRow(test, 'new@example.com')?.emailVerified).toBe(true);
    expect(userRow(test, 'new@outside.example')?.emailVerified).toBe(false);
  });
});

describe('Google sign-in onto an unverified password account', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  const PASSWORD = 'superSecret123!';
  // A Workspace account on the address's domain, so Google speaks for the
  // address.
  const google = (email: string, emailVerified = true) => ({
    sub: `google-${email}`,
    email,
    email_verified: emailVerified,
    hd: 'example.com',
  });

  function pendingRows(test: TestApp) {
    return test.db
      .select()
      .from(verification)
      .all()
      .filter((v) => v.identifier.startsWith('pending-google:'));
  }

  async function signedIn(test: TestApp, cookie: string) {
    const res = await test.app.request('/api/auth/get-session', { headers: { cookie } });
    return (await res.json()) !== null;
  }

  /** Signs in with Google and returns the pending token from the redirect. */
  async function pendingToken(test: TestApp, email: string): Promise<string> {
    const res = await googleSignIn(test, google(email));
    const token = pendingTokenFrom(res);
    expect(token).toBeTruthy();
    return token!;
  }

  const claim = (test: TestApp, token: string, cookie: string) =>
    test.app.request('/api/account/google/claim', {
      method: 'POST',
      headers: { cookie: `${cookie}; ${pendingCookie(token)}` },
    });

  const takeover = (test: TestApp, token: string) =>
    test.app.request('/api/account/google/takeover', {
      method: 'POST',
      headers: { cookie: pendingCookie(token) },
    });

  it('offers the choice instead of refusing, for 10 minutes', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    await signUpTestUser(test, 'mine@example.com');

    const res = await googleSignIn(test, google('mine@example.com'));
    const location = new URL(res.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe('http://localhost:5173/profiles');
    expect(location.searchParams.get('force')).toBe('1');
    expect(location.searchParams.get('error')).toBeNull();
    expect(location.searchParams.get('email')).toBe('mine@example.com');
    const rows = pendingRows(test);
    expect(rows).toHaveLength(1);
    expect(location.searchParams.get('pending')).toBe('1');
    expect(rows[0]!.identifier).toBe(`pending-google:${pendingTokenFrom(res)}`);
    const minutes = (rows[0]!.expiresAt.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(9);
    expect(minutes).toBeLessThanOrEqual(10);
  });

  it('sends the choice to the picker whichever page sign-in started from', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    await signUpTestUser(test, 'elsewhere@example.com');

    const res = await googleSignIn(
      test,
      google('elsewhere@example.com'),
      'http://localhost:5173/verify-email?token=t&email=elsewhere%40example.com',
    );
    const location = new URL(res.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe('http://localhost:5173/profiles');
    expect(location.searchParams.get('pending')).toBeTruthy();
  });

  it("still refuses when Google hasn't verified the address", async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    await signUpTestUser(test, 'unproven@example.com');

    const res = await googleSignIn(test, google('unproven@example.com', false));
    expect(res.headers.get('location')).toContain('error=account_not_linked');
    expect(pendingRows(test)).toHaveLength(0);
  });

  it("links on \"That's me\", keeping the password and verifying", async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    const { cookie, userId } = await signUpTestUser(test, 'me@example.com', PASSWORD);
    const token = await pendingToken(test, 'me@example.com');

    expect((await claim(test, token, cookie)).status).toBe(200);
    expect(providers(test, userId)).toContain('google');
    expect(isVerified(test, userId)).toBe(true);
    const signIn = await postAuth(test, 'sign-in/email', {
      email: 'me@example.com',
      password: PASSWORD,
    });
    expect(signIn.status).toBe(200);
    // Google now signs straight in.
    const again = await googleSignIn(test, google('me@example.com'));
    expect(again.headers.get('location')).toBe('http://localhost:5173/home');
  });

  it("refuses \"That's me\" from a different account", async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    const { userId } = await signUpTestUser(test, 'target@example.com');
    const { cookie } = await signUpTestUser(test, 'someone@example.com');
    const token = await pendingToken(test, 'target@example.com');

    expect((await claim(test, token, cookie)).status).toBe(403);
    expect(providers(test, userId)).not.toContain('google');
    expect(isVerified(test, userId)).toBe(false);
  });

  it("takes over on \"That's not me\", removing the password and every session", async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    const { cookie, userId } = await signUpTestUser(test, 'stolen@example.com', PASSWORD);
    const token = await pendingToken(test, 'stolen@example.com');

    expect((await takeover(test, token)).status).toBe(200);
    expect(providers(test, userId)).not.toContain('credential');
    expect(await signedIn(test, cookie)).toBe(false);
    expect(providers(test, userId)).toContain('google');
    expect(isVerified(test, userId)).toBe(true);
    const oldPassword = await postAuth(test, 'sign-in/email', {
      email: 'stolen@example.com',
      password: PASSWORD,
    });
    expect(oldPassword.status).not.toBe(200);
    // The client then signs in with Google again, which now just works.
    const again = await googleSignIn(test, google('stolen@example.com'));
    expect(again.headers.get('location')).toBe('http://localhost:5173/home');
  });

  it('refuses a takeover once the account is verified, changing nothing', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    const { cookie, userId } = await signUpTestUser(test, 'late@example.com');
    const token = await pendingToken(test, 'late@example.com');
    test.db.update(user).set({ emailVerified: true }).where(eq(user.id, userId)).run();

    const res = await takeover(test, token);
    expect(res.status).toBe(400);
    expect(providers(test, userId)).toContain('credential');
    expect(await signedIn(test, cookie)).toBe(true);
    expect(providers(test, userId)).not.toContain('google');
  });

  it('changes nothing when the Google account went to someone else meanwhile', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    const { cookie, userId } = await signUpTestUser(test, 'contested@example.com');
    const token = await pendingToken(test, 'contested@example.com');
    const other = await signUpTestUser(test, 'other@example.com');
    test.db
      .insert(account)
      .values({
        id: 'contested-google',
        accountId: google('contested@example.com').sub,
        providerId: 'google',
        userId: other.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    expect((await takeover(test, token)).status).toBe(400);
    expect(providers(test, userId)).toContain('credential');
    expect(await signedIn(test, cookie)).toBe(true);
  });

  it('keeps a subpath base in the redirect to the choice', async () => {
    const test = createTestApp({
      authEnv: { ...TEST_GOOGLE_ENV, webOrigin: 'http://localhost:5173/vv' },
    });
    cleanup = test.cleanup;
    await signUpTestUser(test, 'base@example.com');

    const res = await googleSignIn(
      test,
      google('base@example.com'),
      'http://localhost:5173/vv/profiles',
    );
    expect(new URL(res.headers.get('location')!).pathname).toBe('/vv/profiles');
  });

  it('answers a used, expired, or unknown token the same way', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'tokens@example.com');
    const used = await pendingToken(test, 'tokens@example.com');
    expect((await claim(test, used, cookie)).status).toBe(200);

    await signUpTestUser(test, 'expired@example.com');
    const expired = await pendingToken(test, 'expired@example.com');
    test.db
      .update(verification)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(verification.identifier, `pending-google:${expired}`))
      .run();

    const answers = await Promise.all(
      [used, expired, 'unknown'].map(async (token) => {
        const res = await takeover(test, token);
        return { status: res.status, body: await res.text() };
      }),
    );
    expect(answers[0]!.status).toBe(400);
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    const claimed = await claim(test, 'unknown', cookie);
    expect(claimed.status).toBe(400);
  });

  it('verifies the address when Google is connected from settings', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    const { cookie, userId } = await signUpTestUser(test, 'connect@example.com', PASSWORD);

    const res = await googleLink(test, cookie, google('connect@example.com'));
    expect(res.headers.get('location')).toBe('http://localhost:5173/settings');
    expect(providers(test, userId)).toContain('google');
    expect(isVerified(test, userId)).toBe(true);
    expect(providers(test, userId)).toContain('credential');
  });

  it('refuses to connect a Google account with a different address', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    const { cookie, userId } = await signUpTestUser(test, 'mismatch@example.com');

    const res = await googleLink(test, cookie, google('other@example.com'));
    expect(res.headers.get('location')).toContain('error=');
    expect(providers(test, userId)).not.toContain('google');
    expect(isVerified(test, userId)).toBe(false);
  });
});

describe('the Google code step', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  const PASSWORD = 'superSecret123!';
  // Google says it checked these addresses but hosts none of them, so the
  // inbox still needs proving.
  const outside = (email: string) => ({ sub: `google-${email}`, email, email_verified: true });

  // Verified as by its code, which verifying uses up.
  async function verifiedUser(test: TestApp, email: string): Promise<string> {
    const { userId } = await signUpTestUser(test, email, PASSWORD);
    test.db.update(user).set({ emailVerified: true }).where(eq(user.id, userId)).run();
    test.db.delete(verification).where(eq(verification.identifier, `email-verification-otp-${email}`))
      .run();
    return userId;
  }

  function pendingRow(test: TestApp, token: string) {
    const row = test.db
      .select()
      .from(verification)
      .all()
      .find((v) => v.identifier === `pending-google:${token}`);
    return row ? (JSON.parse(row.value) as { proven: boolean }) : undefined;
  }

  /** Signs in with Google and returns the redirect's query, with `pending`
   *  set to the token from the cookie (the address itself carries only "1"). */
  async function signIn(test: TestApp, profile: GoogleProfile) {
    const res = await googleSignIn(test, profile);
    const query = new URL(res.headers.get('location')!).searchParams;
    const token = pendingTokenFrom(res);
    if (token) query.set('pending', token);
    return query;
  }

  const confirm = (test: TestApp, token: string | null, code: string) =>
    test.app.request('/api/account/google/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { cookie: pendingCookie(token) } : {}) },
      body: JSON.stringify({ code }),
    });

  const tokenPost = (test: TestApp, path: string, token: string, cookie?: string) =>
    test.app.request(`/api/account/google/${path}`, {
      method: 'POST',
      headers: { cookie: [cookie, pendingCookie(token)].filter(Boolean).join('; ') },
    });

  it('emails a code and sends the learner to the code step', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    await verifiedUser(test, 'step@example.com');
    test.emails.length = 0;

    const query = await signIn(test, outside('step@example.com'));

    expect(query.get('code')).toBe('1');
    expect(query.get('sent')).toBeNull();
    expect(query.get('email')).toBe('step@example.com');
    expect(pendingRow(test, query.get('pending')!)?.proven).toBe(false);
    expect(test.emails.map((m) => [m.to, m.subject])).toEqual([
      ['step@example.com', 'Your VerseVault code to connect Google'],
    ]);
    expect(test.emails[0]!.text).toMatch(/connecting a Google account/);
  });

  it('links a verified account once the code is confirmed', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    const userId = await verifiedUser(test, 'linkme@example.com');
    const query = await signIn(test, outside('linkme@example.com'));

    const res = await confirm(test, query.get('pending')!, emailCode(test.emails, 'linkme@example.com'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signIn: true });
    expect(providers(test, userId)).toContain('google');

    const again = await googleSignIn(test, outside('linkme@example.com'));
    expect(again.headers.get('location')).toBe('http://localhost:5173/home');
  });

  it('leads an unverified account to the choice once the code is confirmed', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    const { userId, cookie } = await signUpTestUser(test, 'choose@example.com', PASSWORD);
    const query = await signIn(test, outside('choose@example.com'));
    const token = query.get('pending')!;

    const res = await confirm(test, token, emailCode(test.emails, 'choose@example.com'));
    expect(await res.json()).toEqual({ choice: true });
    expect(pendingRow(test, token)?.proven).toBe(true);
    expect(providers(test, userId)).not.toContain('google');

    expect((await tokenPost(test, 'claim', token, cookie)).status).toBe(200);
    expect(providers(test, userId)).toContain('google');
    expect(isVerified(test, userId)).toBe(true);
  });

  it('refuses claim and takeover before the code is confirmed, keeping the row', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    const { userId, cookie } = await signUpTestUser(test, 'early@example.com', PASSWORD);
    const query = await signIn(test, outside('early@example.com'));
    const token = query.get('pending')!;

    const takeover = await tokenPost(test, 'takeover', token);
    const claim = await tokenPost(test, 'claim', token, cookie);
    expect(takeover.status).toBe(400);
    expect(claim.status).toBe(400);
    expect(await claim.json()).toEqual(await takeover.json());
    expect(providers(test, userId)).toContain('credential');
    expect(pendingRow(test, token)?.proven).toBe(false);
  });

  it('ends the code after three wrong tries', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    const userId = await verifiedUser(test, 'guess@example.com');
    const token = (await signIn(test, outside('guess@example.com'))).get('pending')!;
    const code = emailCode(test.emails, 'guess@example.com');

    for (let i = 0; i < 3; i++) {
      expect((await confirm(test, token, wrongFor(code))).status).toBe(400);
    }
    expect((await confirm(test, token, code)).status).toBe(403);
    expect(providers(test, userId)).not.toContain('google');
  });

  it('counts wrong codes sent at the same moment', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    const userId = await verifiedUser(test, 'burst@example.com');
    const token = (await signIn(test, outside('burst@example.com'))).get('pending')!;
    const code = emailCode(test.emails, 'burst@example.com');
    const guesses = Array.from({ length: 10 }, (_, i) => String(i).repeat(6))
      .filter((guess) => guess !== code)
      .slice(0, 8);

    const answers = await Promise.all(guesses.map((guess) => confirm(test, token, guess)));
    expect(answers.every((res) => res.status !== 200)).toBe(true);
    expect((await confirm(test, token, code)).status).not.toBe(200);
    expect(providers(test, userId)).not.toContain('google');
  });

  it('accepts the right code once, even sent twice at the same moment', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    await signUpTestUser(test, 'double@example.com', PASSWORD);
    const token = (await signIn(test, outside('double@example.com'))).get('pending')!;
    const code = emailCode(test.emails, 'double@example.com');

    const answers = await Promise.all([confirm(test, token, code), confirm(test, token, code)]);
    expect(answers.map((res) => res.status).sort()).toEqual([200, 400]);
  });

  it('answers 429 once the per-IP bucket is empty', async () => {
    const test = createTestApp({
      authEnv: TEST_GOOGLE_ENV,
      observability: { unauthedAuthTier: { capacity: 2, refillPerSec: 0 } },
    });
    cleanup = test.cleanup;
    const post = () =>
      test.app.request('/api/account/google/confirm', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'cf-connecting-ip': '203.0.113.9',
          cookie: pendingCookie('nope'),
        },
        body: JSON.stringify({ code: '123456' }),
      });
    expect((await post()).status).toBe(400);
    expect((await post()).status).toBe(400);
    expect((await post()).status).toBe(429);
  });

  it('proves an authoritative sign-in onto an unverified account at once', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    await signUpTestUser(test, 'hosted@example.com', PASSWORD);
    test.emails.length = 0;

    const query = await signIn(test, { ...outside('hosted@example.com'), hd: 'example.com' });

    expect(query.get('code')).toBeNull();
    expect(pendingRow(test, query.get('pending')!)?.proven).toBe(true);
    expect(test.emails).toHaveLength(0);
  });

  it('counts the code email towards the per-address limit', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    await verifiedUser(test, 'limit@example.com');
    await signIn(test, outside('limit@example.com'));

    const reset = () => postAuth(test, 'email-otp/request-password-reset', { email: 'limit@example.com' });
    expect((await reset()).status).toBe(200);
    expect((await reset()).status).toBe(200);
    expect((await reset()).status).toBe(429);
  });

  it('acts only for the browser that signed in with Google', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    const userId = await verifiedUser(test, 'phish@example.com');
    const res = await googleSignIn(test, outside('phish@example.com'));
    // The page address carries no token to hand on.
    expect(new URL(res.headers.get('location')!).searchParams.get('pending')).toBe('1');

    const code = emailCode(test.emails, 'phish@example.com');
    expect((await confirm(test, null, code)).status).toBe(400);
    expect(providers(test, userId)).not.toContain('google');
  });

  it('sends a new code-step code on request, saying what it is for', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    await verifiedUser(test, 'again@example.com');
    const token = (await signIn(test, outside('again@example.com'))).get('pending')!;
    const older = emailCode(test.emails, 'again@example.com');

    const res = await tokenPost(test, 'resend', token);
    expect(res.status).toBe(200);
    expect(test.emails.at(-1)?.subject).toBe('Your VerseVault code to connect Google');
    const newer = emailCode(test.emails, 'again@example.com');
    if (older !== newer) expect((await confirm(test, token, older)).status).toBe(400);
    expect((await confirm(test, token, newer)).status).toBe(200);
  });

  it("keeps a code the owner already holds rather than replacing it", async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'holding@example.com', PASSWORD);
    const held = emailCode(test.emails, 'holding@example.com');
    test.emails.length = 0;

    await signIn(test, outside('holding@example.com'));
    expect(test.emails).toHaveLength(0);
    const res = await postAuth(
      test,
      'email-otp/verify-email',
      { email: 'holding@example.com', otp: held },
      cookie,
    );
    expect(res.status).toBe(200);
  });

  it('tells the owner when Google joins an account that signs in another way', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    await verifiedUser(test, 'told@example.com');
    const token = (await signIn(test, outside('told@example.com'))).get('pending')!;

    await confirm(test, token, emailCode(test.emails, 'told@example.com'));
    expect(test.emails.at(-1)?.subject).toBe('Google was connected to your VerseVault account');
    expect(test.emails.at(-1)?.to).toBe('told@example.com');

    // A new Google-only sign-up has nothing to warn about.
    test.emails.length = 0;
    await googleSignIn(test, { sub: 'g-new', email: 'brand-new@gmail.com', email_verified: true });
    expect(test.emails.filter((m) => m.subject.startsWith('Google was connected'))).toHaveLength(0);
  });

  it('refuses a request naming a different pending sign-in than the cookie', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    await signUpTestUser(test, 'tab-b@example.com', PASSWORD);
    const token = (await signIn(test, { ...outside('tab-b@example.com'), hd: 'example.com' }))
      .get('pending')!;

    // Tab A still shows a choice about another address.
    const res = await test.app.request('/api/account/google/takeover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: pendingCookie(token) },
      body: JSON.stringify({ email: 'tab-a@example.com' }),
    });
    expect(res.status).toBe(400);
    expect(pendingRow(test, token)?.proven).toBe(true);
  });

  it('sets the pending cookie for the Google routes under a prefixed API URL', async () => {
    const test = createTestApp({ authEnv: { ...TEST_GOOGLE_ENV, baseUrl: 'http://localhost:3000/vv' } });
    cleanup = test.cleanup;
    await verifiedUser(test, 'prefixed@example.com');
    const res = await googleSignIn(test, outside('prefixed@example.com'));
    expect(res.headers.get('set-cookie')).toMatch(
      /better-auth\.pending_google=[^;]+;[^,]*Path=\/vv\/api\/account\/google/,
    );
  });

  it('keeps the destination sign-in started with', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    await verifiedUser(test, 'deep@example.com');

    const res = await googleSignIn(
      test,
      outside('deep@example.com'),
      'http://localhost:5173/profiles?redirect=%2Fsettings%2Faccount',
    );
    const query = new URL(res.headers.get('location')!).searchParams;
    expect(query.get('redirect')).toBe('/settings/account');
    expect(query.get('code')).toBe('1');
  });

  it("keeps a desktop client's tauri:// origin in the redirect", async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    await verifiedUser(test, 'desktop@example.com');

    const res = await googleSignIn(test, outside('desktop@example.com'), 'tauri://localhost/profiles');
    expect(res.headers.get('location')).toMatch(/^tauri:\/\/localhost\/profiles\?.*code=1/);
  });

  it('replaces the older code when Google sends another', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    await verifiedUser(test, 'twice@example.com');
    await signIn(test, outside('twice@example.com'));
    const older = emailCode(test.emails, 'twice@example.com');
    const token = (await signIn(test, outside('twice@example.com'))).get('pending')!;
    const newer = emailCode(test.emails, 'twice@example.com');

    if (older !== newer) expect((await confirm(test, token, older)).status).toBe(400);
    expect((await confirm(test, token, newer)).status).toBe(200);
  });

  it('sends no code past the per-address limit, and still goes to the code step', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    await verifiedUser(test, 'spent@example.com');
    for (let i = 0; i < 3; i++) {
      await postAuth(test, 'email-otp/request-password-reset', { email: 'spent@example.com' });
    }
    test.emails.length = 0;

    const query = await signIn(test, outside('spent@example.com'));
    expect(query.get('code')).toBe('1');
    expect(query.get('sent')).toBe('0');
    expect(test.emails).toHaveLength(0);
  });

  it('leaves the code and the row when the Google account belongs to someone else', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    const { cookie, userId } = await signUpTestUser(test, 'taken@example.com', PASSWORD);
    test.db.update(user).set({ emailVerified: true }).where(eq(user.id, userId)).run();
    const token = (await signIn(test, outside('taken@example.com'))).get('pending')!;
    const code = emailCode(test.emails, 'taken@example.com');
    const other = await signUpTestUser(test, 'other-owner@example.com');
    test.db
      .update(account)
      .set({ accountId: 'google-taken@example.com', providerId: 'google' })
      .where(eq(account.userId, other.userId))
      .run();

    expect((await confirm(test, token, code)).status).toBe(400);
    expect(pendingRow(test, token)).toBeDefined();
    const verifyRes = await postAuth(
      test,
      'email-otp/verify-email',
      { email: 'taken@example.com', otp: code },
      cookie,
    );
    expect(verifyRes.status).toBe(200);
  });

  it('keeps a proven row for the right account when another account claims it', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    const { cookie, userId } = await signUpTestUser(test, 'mine@example.com', PASSWORD);
    const query = await signIn(test, { ...outside('mine@example.com'), hd: 'example.com' });
    const token = query.get('pending')!;
    const other = await signUpTestUser(test, 'not-mine@example.com');

    expect((await tokenPost(test, 'claim', token, other.cookie)).status).toBe(403);
    expect((await tokenPost(test, 'claim', token, cookie)).status).toBe(200);
    expect(providers(test, userId)).toContain('google');
  });

  /** Hands the Google account `sub` to a new user, as if linked meanwhile. */
  async function ownedElsewhere(test: TestApp, sub: string) {
    const other = await signUpTestUser(test, `owner-${sub.replace(/\W/g, '-')}@example.com`);
    test.db.insert(account).values({
      id: `acc-${sub}`,
      userId: other.userId,
      accountId: sub,
      providerId: 'google',
      createdAt: new Date(),
      updatedAt: new Date(),
    }).run();
  }

  it('keeps an unverified account\'s code when the Google account belongs to someone else', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    await signUpTestUser(test, 'held@example.com', PASSWORD);
    const token = (await signIn(test, outside('held@example.com'))).get('pending')!;
    await ownedElsewhere(test, 'google-held@example.com');

    const code = emailCode(test.emails, 'held@example.com');
    expect((await confirm(test, token, code)).status).toBe(400);
    expect(pendingRow(test, token)?.proven).toBe(false);
  });

  it('gives the choice its own 10 minutes once the code is confirmed', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    await signUpTestUser(test, 'slow@example.com', PASSWORD);
    const token = (await signIn(test, outside('slow@example.com'))).get('pending')!;
    test.db
      .update(verification)
      .set({ expiresAt: new Date(Date.now() + 60_000) })
      .where(eq(verification.identifier, `pending-google:${token}`))
      .run();

    await confirm(test, token, emailCode(test.emails, 'slow@example.com'));
    const row = test.db
      .select()
      .from(verification)
      .all()
      .find((v) => v.identifier === `pending-google:${token}`)!;
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
  });

  it('keeps a proven row when the takeover or claim is refused', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    const { cookie, userId } = await signUpTestUser(test, 'kept@example.com', PASSWORD);
    const profile = { ...outside('kept@example.com'), hd: 'example.com' };
    const token = (await signIn(test, profile)).get('pending')!;

    // Verified meanwhile: the takeover is refused.
    test.db.update(user).set({ emailVerified: true }).where(eq(user.id, userId)).run();
    expect((await tokenPost(test, 'takeover', token)).status).toBe(400);
    expect(pendingRow(test, token)?.proven).toBe(true);

    // The Google account linked elsewhere meanwhile: the claim is refused.
    await ownedElsewhere(test, profile.sub);
    expect((await tokenPost(test, 'claim', token, cookie)).status).toBe(400);
    expect(pendingRow(test, token)?.proven).toBe(true);
  });

  it('refuses a second user for the same Google account in the database', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    await ownedElsewhere(test, 'google-shared');
    const second = await signUpTestUser(test, 'second@example.com');
    const insert = () =>
      test.db.insert(account).values({
        id: 'acc-second',
        userId: second.userId,
        accountId: 'google-shared',
        providerId: 'google',
        createdAt: new Date(),
        updatedAt: new Date(),
      }).run();
    expect(insert).toThrow(/UNIQUE/);
  });

  it('connects an outside Google account to a verified account from settings', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    const { cookie, userId } = await signUpTestUser(test, 'connect@example.com', PASSWORD);
    test.db.update(user).set({ emailVerified: true }).where(eq(user.id, userId)).run();

    const res = await googleLink(test, cookie, outside('connect@example.com'));
    expect(res.headers.get('location')).toBe('http://localhost:5173/settings');
    expect(providers(test, userId)).toContain('google');
  });

  it('asks an unverified account to verify before connecting an outside Google account', async () => {
    const test = createTestApp({ authEnv: TEST_GOOGLE_ENV });
    cleanup = test.cleanup;
    const { cookie, userId } = await signUpTestUser(test, 'first@example.com', PASSWORD);

    const res = await googleLink(test, cookie, outside('first@example.com'));
    expect(res.headers.get('location')).toContain('error=verify_email_first');
    expect(providers(test, userId)).not.toContain('google');
    expect(isVerified(test, userId)).toBe(false);
  });
});
