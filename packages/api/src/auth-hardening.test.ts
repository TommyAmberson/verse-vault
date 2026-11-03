import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BREACHED_PASSWORD,
  type TestApp,
  createTestApp,
  emailCode,
  signUpTestUser,
} from './test-utils.js';

function postAuth(test: TestApp, path: string, body: object, cookie?: string) {
  return test.app.request(`/api/auth/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.unstubAllEnvs();
});

describe('rate limits in production', () => {
  it('limit password guesses, with room for a group on one network', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const test = createTestApp();
    cleanup = test.cleanup;
    await signUpTestUser(test, 'coach@example.com');

    const statuses: number[] = [];
    for (let i = 0; i < 16; i++) {
      const res = await postAuth(test, 'sign-in/email', {
        email: 'coach@example.com',
        password: 'not-the-password',
      });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 15)).not.toContain(429);
    expect(statuses[15]).toBe(429);
  });
});

describe('sending a verification code', () => {
  it('needs a session on that account', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    await signUpTestUser(test, 'owner@example.com');
    const other = await signUpTestUser(test, 'other@example.com');
    const sent = test.emails.length;
    const body = { email: 'owner@example.com', type: 'email-verification' };

    const signedOut = await postAuth(test, 'email-otp/send-verification-otp', body);
    const otherAccount = await postAuth(test, 'email-otp/send-verification-otp', body, other.cookie);

    expect([signedOut.status, otherAccount.status]).toEqual([403, 403]);
    expect(test.emails.length).toBe(sent);
  });

  it("isn't sent through phase 1's route either", async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    await signUpTestUser(test, 'old-route@example.com');
    const sent = test.emails.length;
    const res = await postAuth(test, 'send-verification-email', { email: 'old-route@example.com' });
    expect(res.status).toBe(404);
    expect(test.emails.length).toBe(sent);
  });

  it('still goes out at sign-up', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    await signUpTestUser(test, 'new@example.com');
    expect(test.emails.some((m) => m.to === 'new@example.com')).toBe(true);
  });
});

describe('form posts from another origin', () => {
  it('are refused on every cookie route, not only the account ones', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'forged@example.com');
    const res = await test.app.request('/api/materials/enroll', {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example', 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });
});

describe('breached passwords', () => {
  it('are refused at sign-up', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const res = await postAuth(test, 'sign-up/email', {
      email: 'new@example.com',
      password: BREACHED_PASSWORD,
      name: 'new@example.com',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'PASSWORD_COMPROMISED' });
  });

  it('are refused at reset, keeping the code', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    await signUpTestUser(test, 'reset@example.com');
    await postAuth(test, 'email-otp/request-password-reset', { email: 'reset@example.com' });
    const otp = emailCode(test.emails, 'reset@example.com');

    const refused = await postAuth(test, 'email-otp/reset-password', {
      email: 'reset@example.com',
      otp,
      password: BREACHED_PASSWORD,
    });
    expect(refused.status).toBe(400);

    const retry = await postAuth(test, 'email-otp/reset-password', {
      email: 'reset@example.com',
      otp,
      password: 'a-much-better-password',
    });
    expect(retry.status).toBe(200);
  });

  it('are refused as a new password for a signed-in account', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'change@example.com');
    const res = await postAuth(
      test,
      'change-password',
      { currentPassword: 'superSecret123!', newPassword: BREACHED_PASSWORD },
      cookie,
    );
    expect(res.status).toBe(400);
  });

  it("refuse a password they can't check, rather than accept it", async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    const res = await postAuth(test, 'sign-up/email', {
      email: 'later@example.com',
      password: 'a-fine-password-1',
      name: 'later@example.com',
    });
    spy.mockRestore();
    expect(res.status).toBe(503);
  });
});
