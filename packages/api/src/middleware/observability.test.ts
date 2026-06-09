import { describe, expect, it } from 'vitest';

import { TokenBucketStore } from '../lib/rate-limit.js';
import { createTestApp } from '../test-utils.js';

const TIGHT_AUTHED = { capacity: 2, refillPerSec: 0 };
const TIGHT_UNAUTHED = { capacity: 3, refillPerSec: 0 };

// Captures the JSON log lines for assertion.
function makeLogger() {
  const lines: string[] = [];
  return {
    lines,
    log: (line: string) => lines.push(line),
    parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

// Inject a stable clock so durationMs is deterministic. The middleware
// reads now() twice (start + end); without per-test isolation the
// elapsed delta is whatever the test runner happened to take.
function fixedClock() {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('observability middleware', () => {
  it('exempts /health from rate limiting but still logs each request', async () => {
    const { log, lines, parsed } = makeLogger();
    const { app, cleanup } = createTestApp({
      observability: { authedTier: TIGHT_AUTHED, log },
    });
    try {
      for (let i = 0; i < TIGHT_AUTHED.capacity + 5; i++) {
        const res = await app.request('/health');
        expect(res.status).toBe(200);
      }
      expect(lines.length).toBe(TIGHT_AUTHED.capacity + 5);
      for (const entry of parsed()) {
        expect(entry.path).toBe('/health');
        expect(entry.status).toBe(200);
      }
    } finally {
      cleanup();
    }
  });

  it('rate-limits past the authed tier capacity and returns 429 with Retry-After', async () => {
    const { log, parsed } = makeLogger();
    const clock = fixedClock();
    const { app, cleanup } = createTestApp({
      observability: {
        authedTier: TIGHT_AUTHED,
        log,
        now: clock.now,
      },
    });
    try {
      // First two pass; third hits 429.
      let res = await app.request('/api/sync/nkjv-cor/state');
      expect(res.status).not.toBe(429);
      res = await app.request('/api/sync/nkjv-cor/state');
      expect(res.status).not.toBe(429);
      res = await app.request('/api/sync/nkjv-cor/state');
      expect(res.status).toBe(429);
      const retryAfter = res.headers.get('Retry-After');
      expect(retryAfter).toBeTruthy();
      // refillPerSec is 0 → retryAfter would be Infinity. Middleware
      // clamps via Math.ceil to a finite header but we mainly need
      // SOME value present.
      expect(Number.parseInt(retryAfter!, 10)).toBeGreaterThanOrEqual(1);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('Rate limit exceeded');

      // 429 emitted a log line with rateLimited true + bucketKey for
      // operator debugging.
      const rl = parsed().filter((e) => e.status === 429);
      expect(rl).toHaveLength(1);
      expect(rl[0].rateLimited).toBe(true);
      expect(rl[0].bucketKey).toBe('ip:unknown');
    } finally {
      cleanup();
    }
  });

  it('uses the tighter unauthedAuthTier for /api/auth/*', async () => {
    const { log, parsed } = makeLogger();
    const { app, cleanup } = createTestApp({
      observability: {
        authedTier: { capacity: 10_000, refillPerSec: 100 },
        unauthedAuthTier: TIGHT_UNAUTHED,
        log,
      },
    });
    try {
      let lastStatus = 0;
      for (let i = 0; i < TIGHT_UNAUTHED.capacity + 1; i++) {
        const res = await app.request('/api/auth/some-endpoint', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        lastStatus = res.status;
      }
      expect(lastStatus).toBe(429);
      // The 429 came from the unauthed-auth tier — the authed tier's
      // 10k capacity wouldn't have tripped yet.
      const rl = parsed().filter((e) => e.status === 429);
      expect(rl).toHaveLength(1);
      expect(rl[0].path).toMatch(/^\/api\/auth\//);
    } finally {
      cleanup();
    }
  });

  it('routes /api/auth/get-session through the loose authedTier, not unauthedAuthTier', async () => {
    const { log, parsed } = makeLogger();
    const { app, cleanup } = createTestApp({
      observability: {
        // Looser-than-default authed tier so the test can hammer the
        // session-state endpoint without hitting that tier's cap.
        authedTier: { capacity: 1_000, refillPerSec: 0 },
        // Tight unauthedAuth tier: if get-session were routed here, it
        // would 429 after `TIGHT_UNAUTHED.capacity` requests.
        unauthedAuthTier: TIGHT_UNAUTHED,
        rateLimitUnknownIp: true,
        log,
      },
    });
    try {
      // Hammer get-session well past the tight tier's capacity.
      for (let i = 0; i < TIGHT_UNAUTHED.capacity + 20; i++) {
        const res = await app.request('/api/auth/get-session', {
          headers: { Origin: 'http://localhost:5173' },
        });
        expect(res.status).not.toBe(429);
      }
      expect(parsed().filter((e) => e.status === 429)).toHaveLength(0);
      // But sign-in/email -- a real credential surface -- still gets
      // the tight tier from the same bucket.
      let lastStatus = 0;
      for (let i = 0; i < TIGHT_UNAUTHED.capacity + 1; i++) {
        const res = await app.request('/api/auth/sign-in/email', {
          method: 'POST',
          body: JSON.stringify({}),
          headers: { Origin: 'http://localhost:5173' },
        });
        lastStatus = res.status;
      }
      expect(lastStatus).toBe(429);
    } finally {
      cleanup();
    }
  });

  it('skips OPTIONS preflights from both bucket and log', async () => {
    const { log, lines } = makeLogger();
    const { app, cleanup } = createTestApp({
      observability: { authedTier: TIGHT_AUTHED, log },
    });
    try {
      for (let i = 0; i < 50; i++) {
        const res = await app.request('/api/sync/nkjv-cor/state', {
          method: 'OPTIONS',
          headers: { Origin: 'http://localhost:5173' },
        });
        // CORS middleware handles preflights — status is 204 (or
        // similar non-error).
        expect(res.status).not.toBe(429);
      }
      expect(lines.length).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('isolates buckets per CF-Connecting-IP', async () => {
    const { log } = makeLogger();
    const { app, cleanup } = createTestApp({
      observability: { authedTier: TIGHT_AUTHED, log },
    });
    try {
      // IP A drains its bucket.
      for (let i = 0; i < TIGHT_AUTHED.capacity; i++) {
        const res = await app.request('/api/sync/nkjv-cor/state', {
          headers: { 'CF-Connecting-IP': '1.1.1.1' },
        });
        expect(res.status).not.toBe(429);
      }
      // IP B is fresh.
      const resB = await app.request('/api/sync/nkjv-cor/state', {
        headers: { 'CF-Connecting-IP': '2.2.2.2' },
      });
      expect(resB.status).not.toBe(429);
      // IP A is over quota.
      const resA = await app.request('/api/sync/nkjv-cor/state', {
        headers: { 'CF-Connecting-IP': '1.1.1.1' },
      });
      expect(resA.status).toBe(429);
    } finally {
      cleanup();
    }
  });

  it('refills tokens after the injected clock advances past the window', async () => {
    const { log } = makeLogger();
    const clock = fixedClock();
    const tier = { capacity: 1, refillPerSec: 1 };
    const { app, cleanup } = createTestApp({
      observability: { authedTier: tier, log, now: clock.now },
    });
    try {
      let res = await app.request('/api/sync/nkjv-cor/state');
      expect(res.status).not.toBe(429);
      res = await app.request('/api/sync/nkjv-cor/state');
      expect(res.status).toBe(429);
      clock.advance(2_000); // 2 sec → 2 tokens refilled, cap at 1
      res = await app.request('/api/sync/nkjv-cor/state');
      expect(res.status).not.toBe(429);
    } finally {
      cleanup();
    }
  });

  it('caps the bucket store at maxBuckets and never leaks', async () => {
    const { log } = makeLogger();
    const buckets = new TokenBucketStore({ maxBuckets: 2 });
    const { app, cleanup } = createTestApp({
      observability: { authedTier: TIGHT_AUTHED, buckets, log },
    });
    try {
      for (const ip of ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4']) {
        await app.request('/api/sync/nkjv-cor/state', {
          headers: { 'CF-Connecting-IP': ip },
        });
      }
      expect(buckets.size()).toBe(2);
    } finally {
      cleanup();
    }
  });

  it('emits a JSON log line with the expected shape on every request', async () => {
    const { log, parsed } = makeLogger();
    const clock = fixedClock();
    const { app, cleanup } = createTestApp({
      observability: { log, now: clock.now },
    });
    try {
      clock.advance(0);
      const res = await app.request('/health');
      expect(res.status).toBe(200);
      expect(parsed()).toHaveLength(1);
      const entry = parsed()[0];
      expect(entry.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(entry.userId).toBeNull();
      expect(entry.ip).toBe('unknown');
      expect(entry.method).toBe('GET');
      expect(entry.path).toBe('/health');
      expect(entry.status).toBe(200);
      expect(typeof entry.durationMs).toBe('number');
      expect(Number.isFinite(entry.durationMs)).toBe(true);
      // X-Request-Id header echoes the log's requestId.
      expect(res.headers.get('X-Request-Id')).toBe(entry.requestId);
    } finally {
      cleanup();
    }
  });

  it('skips the bucket for ip:unknown when rateLimitUnknownIp is false', async () => {
    const { log, parsed } = makeLogger();
    const { app, cleanup } = createTestApp({
      observability: {
        authedTier: TIGHT_AUTHED,
        unauthedAuthTier: TIGHT_UNAUTHED,
        rateLimitUnknownIp: false,
        log,
      },
    });
    try {
      // Far more requests than either tier's capacity. None of these
      // carry CF-Connecting-IP, so they all resolve to ip:unknown.
      for (let i = 0; i < TIGHT_AUTHED.capacity + 20; i++) {
        const res = await app.request('/api/sync/nkjv-cor/state');
        expect(res.status).not.toBe(429);
      }
      const rl = parsed().filter((e) => e.status === 429);
      expect(rl).toHaveLength(0);
      // A request that DOES carry a CF-Connecting-IP still gets bucketed
      // — the skip only applies to ip:unknown.
      for (let i = 0; i < TIGHT_AUTHED.capacity; i++) {
        await app.request('/api/sync/nkjv-cor/state', {
          headers: { 'CF-Connecting-IP': '9.9.9.9' },
        });
      }
      const over = await app.request('/api/sync/nkjv-cor/state', {
        headers: { 'CF-Connecting-IP': '9.9.9.9' },
      });
      expect(over.status).toBe(429);
    } finally {
      cleanup();
    }
  });

  it('returns CORS headers on 429 responses so the browser can read them', async () => {
    const { log } = makeLogger();
    const { app, cleanup } = createTestApp({
      observability: {
        authedTier: TIGHT_AUTHED,
        // Force the bucket to engage even though tests resolve to ip:unknown.
        rateLimitUnknownIp: true,
        log,
      },
    });
    try {
      // Drain the bucket, then send one over-quota request from a
      // browser-style Origin to exercise the CORS layer's response.
      for (let i = 0; i < TIGHT_AUTHED.capacity; i++) {
        await app.request('/api/sync/nkjv-cor/state', {
          headers: { Origin: 'http://localhost:5173' },
        });
      }
      const res = await app.request('/api/sync/nkjv-cor/state', {
        headers: { Origin: 'http://localhost:5173' },
      });
      expect(res.status).toBe(429);
      // Without this header the browser blocks the response as a CORS
      // error and the client sees "NetworkError" instead of a 429 +
      // Retry-After. cors() must run outside observability so its
      // before-phase sets Allow-Origin on the response observability
      // produces directly.
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
        'http://localhost:5173',
      );
      expect(res.headers.get('Retry-After')).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  it('logs status=500 and rethrows when a handler throws', async () => {
    const { log, parsed } = makeLogger();
    const { app, cleanup } = createTestApp({
      observability: { log },
    });
    try {
      // Mount a handler that throws on a known path.
      app.get('/test/boom', () => {
        throw new Error('intentional explosion');
      });
      // Hono's default error handler converts the throw to a 500.
      const res = await app.request('/test/boom');
      expect(res.status).toBe(500);
      const entry = parsed().find((e) => e.path === '/test/boom');
      expect(entry).toBeDefined();
      expect(entry!.status).toBe(500);
      expect(entry!.error).toBe('intentional explosion');
    } finally {
      cleanup();
    }
  });
});
