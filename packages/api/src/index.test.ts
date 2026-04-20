import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

describe('health', () => {
  it('returns ok', async () => {
    const app = createApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'ok' });
  });
});
