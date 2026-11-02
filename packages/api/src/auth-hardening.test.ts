import { afterEach, describe, expect, it, vi } from 'vitest';

import { type TestApp, createTestApp, signUpTestUser } from './test-utils.js';

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
