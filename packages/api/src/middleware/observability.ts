import { randomUUID } from 'node:crypto';

import type { Context, MiddlewareHandler } from 'hono';

import { type RateLimitTier, TokenBucketStore } from '../lib/rate-limit.js';

import type { AppVariables } from './session.js';

/**
 * Joint observability + rate-limit middleware.
 *
 * Per request:
 *  1. Generate a `requestId`, capture `startedAtMs`.
 *  2. Decide whether to skip rate limiting. Exempt: `OPTIONS` preflights,
 *     `/health`, and requests resolving to `ip:unknown` when the
 *     `rateLimitUnknownIp` option is false (local-dev escape hatch).
 *  3. Otherwise consume a token from the appropriate tier. Credential
 *     surfaces under `/api/auth/*` (sign-in, sign-up, password reset,
 *     OAuth callbacks, sign-out, multi-session state changes) hit the
 *     tight `unauthedAuthTier`; cheap session-state reads on the same
 *     prefix (see `AUTH_LOOSE_PATHS`) and everything outside `/api/auth/*`
 *     hit the looser `authedTier`. Over-quota → return `429` with
 *     `Retry-After`.
 *  4. Call `next()` in try/finally so the log line emits even if a
 *     handler throws. Re-throw so Hono's default error handler still
 *     runs.
 *  5. Emit one JSON line to stdout with the request-scope fields. Lines
 *     land in journald via the systemd unit on the VPS.
 *
 * The token is consumed BEFORE `next()` runs — a handler that throws on
 * specific inputs doesn't double as a rate-limit bypass.
 *
 * v1 bucket key is IP-only (per the plan; see `docs/server-api.md` →
 * Rate limiting). Switching the authed tier to per-user keying is a
 * follow-up if NAT'd users start tripping limits.
 */

export interface ObservabilityOptions {
  /** Token-bucket tier applied to every non-auth route. Defaults map
   *  to 120 req/min sustained with a 120-token burst — covers
   *  grade-sequence sessions comfortably (~2 req/sec). */
  authedTier: RateLimitTier;
  /** Tighter tier for `/api/auth/*` to defang credential-stuffing
   *  loops. Defaults to 10 req/min (1 token / 6 sec, burst 10). */
  unauthedAuthTier: RateLimitTier;
  /** Inject your own store for tests; defaults to a fresh
   *  `TokenBucketStore({ now })`. */
  buckets?: TokenBucketStore;
  /** Where the JSON-line log lands. Default is `console.log`, which
   *  the systemd unit captures into journald. Tests pass a callback
   *  that appends to an array. */
  log?: (line: string) => void;
  /** ms-epoch clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Request-id generator. Defaults to `crypto.randomUUID`. */
  randomId?: () => string;
  /** Whether to rate-limit requests that resolve to `ip:unknown` (no
   *  `CF-Connecting-IP` and no `X-Forwarded-For`). Defaults to `true`
   *  in production (NODE_ENV=production) and `false` elsewhere.
   *
   *  Local dev needs `false`: localhost requests carry neither header,
   *  so every unauthenticated request collapses into one shared
   *  bucket and a couple of page refreshes exhaust the `unauthedAuth`
   *  tier. In production the Cloudflare Tunnel always injects
   *  `CF-Connecting-IP`, so a request landing as `ip:unknown` is
   *  either a misconfig or a bypass attempt and gets limited as a
   *  defense-in-depth measure. */
  rateLimitUnknownIp?: boolean;
}

export interface ResolvedObservabilityOptions {
  authedTier: RateLimitTier;
  unauthedAuthTier: RateLimitTier;
  buckets: TokenBucketStore;
  log: (line: string) => void;
  now: () => number;
  randomId: () => string;
  rateLimitUnknownIp: boolean;
}

export const DEFAULT_AUTHED_TIER: RateLimitTier = { capacity: 120, refillPerSec: 2 };
export const DEFAULT_UNAUTHED_AUTH_TIER: RateLimitTier = {
  capacity: 10,
  refillPerSec: 10 / 60,
};

export function resolveObservabilityOptions(
  opts: Partial<ObservabilityOptions> = {},
): ResolvedObservabilityOptions {
  const now = opts.now ?? Date.now;
  return {
    authedTier: opts.authedTier ?? DEFAULT_AUTHED_TIER,
    unauthedAuthTier: opts.unauthedAuthTier ?? DEFAULT_UNAUTHED_AUTH_TIER,
    buckets: opts.buckets ?? new TokenBucketStore({ now }),
    log: opts.log ?? ((line) => console.log(line)),
    now,
    randomId: opts.randomId ?? randomUUID,
    rateLimitUnknownIp:
      opts.rateLimitUnknownIp ?? process.env.NODE_ENV === 'production',
  };
}

/** Paths under `/api/auth/*` that route to the looser `authedTier`
 *  instead of the credential-stuffing tier. These are the cheap,
 *  high-frequency session-state reads the web client hits on every
 *  app boot and every route navigation — they are not credential
 *  surfaces, and treating them as such drowns normal browsing in
 *  429s long before any attack-shaped traffic would.
 *
 *  Everything ELSE under `/api/auth/*` (sign-in/email, sign-up/email,
 *  forget-password, reset-password, callbacks, sign-out, multi-session
 *  state-change ops) keeps the tight `unauthedAuthTier`. */
const AUTH_LOOSE_PATHS = new Set<string>([
  '/api/auth/get-session',
  '/api/auth/multi-session/list-device-sessions',
]);

/** IP source: Cloudflare Tunnel → standard proxy header → fallback.
 *  In tests the harness doesn't synthesise a socket; injecting
 *  `CF-Connecting-IP` per request keeps test buckets isolated. */
function resolveIp(c: Context): string {
  const cf = c.req.header('CF-Connecting-IP');
  if (cf) return cf;
  const xff = c.req.header('X-Forwarded-For');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return 'unknown';
}

export function observabilityMiddleware(
  opts: ResolvedObservabilityOptions,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (c, next) => {
    const requestId = opts.randomId();
    const startedAtMs = opts.now();
    const ip = resolveIp(c);
    const method = c.req.method;
    const path = c.req.path;

    c.set('requestId', requestId);
    c.res.headers.set('X-Request-Id', requestId);

    // OPTIONS preflights run downstream CORS — no bucket, no log line.
    // Logging every preflight would multiply journal volume without
    // observability benefit.
    if (method === 'OPTIONS') {
      return next();
    }

    // /health is exempt from rate limiting but still logged — uptime
    // probes need to see the same correlation fields as real traffic.
    const isHealth = path === '/health';
    // The tighter `unauthedAuthTier` covers credential surfaces under
    // /api/auth/* — sign-in, sign-up, password reset, OAuth callbacks,
    // sign-out, multi-session state-change ops. Frequent session-state
    // reads (see AUTH_LOOSE_PATHS) fall back to the looser `authedTier`
    // so a refresher isn't rate-limited like an attacker.
    const isAuthTight = path.startsWith('/api/auth/') && !AUTH_LOOSE_PATHS.has(path);
    // In local dev nothing injects CF-Connecting-IP / X-Forwarded-For,
    // so every unauthenticated request shares the `ip:unknown` bucket
    // and a couple of page refreshes exhaust it. See
    // `rateLimitUnknownIp` on ObservabilityOptions.
    const skipForUnknownIp = ip === 'unknown' && !opts.rateLimitUnknownIp;

    if (!isHealth && !skipForUnknownIp) {
      const tier = isAuthTight ? opts.unauthedAuthTier : opts.authedTier;
      const key = `ip:${ip}`;
      const result = opts.buckets.consume(key, tier);
      if (!result.allowed) {
        // Clamp to a finite, sensible upper bound. A zero refill rate
        // (test-only edge case) produces Infinity from the deficit math,
        // which would render as the literal "Infinity" in the header
        // and break clients parsing as int.
        const raw = Number.isFinite(result.retryAfterSec)
          ? Math.ceil(result.retryAfterSec)
          : 3600;
        const retryAfter = Math.max(1, Math.min(3600, raw));
        c.res.headers.set('Retry-After', String(retryAfter));
        const status = 429;
        const durationMs = opts.now() - startedAtMs;
        // `bucketKey` is logged separately from `ip` so future per-user
        // keying (`user:<id>`) stays observable without changing the
        // shape — operators debugging "why am I being limited?" can
        // grep the same field regardless of tier.
        opts.log(
          JSON.stringify({
            requestId,
            userId: null,
            ip,
            method,
            path,
            status,
            durationMs,
            rateLimited: true,
            bucketKey: key,
          }),
        );
        return c.json({ error: 'Rate limit exceeded' }, status);
      }
    }

    let caught: unknown = null;
    try {
      await next();
    } catch (err) {
      caught = err;
    }
    // Hono's app-level error handling can catch handler throws inside
    // its dispatch loop before they propagate up through `next()`. In
    // that case `c.error` carries the thrown value and `c.res.status`
    // is already 500. Falling back to `c.error` lets us log the
    // underlying error even when `await next()` resolved cleanly.
    const error = caught ?? c.error;
    const durationMs = opts.now() - startedAtMs;
    const userId = c.get('user')?.id ?? null;
    const status = c.res.status;
    const record: Record<string, unknown> = {
      requestId,
      userId,
      ip,
      method,
      path,
      status,
      durationMs,
    };
    if (error) {
      record.error = error instanceof Error ? error.message : String(error);
    }
    opts.log(JSON.stringify(record));
    if (caught) throw caught;
  };
}
