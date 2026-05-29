/**
 * Token-bucket rate-limit store. Pure in-memory state, single-VPS scale.
 *
 * Each bucket tracks `(tokens, lastRefillMs)`. `consume(key, tier)` refills
 * lazily based on elapsed time since `lastRefillMs`, decrements one token
 * if allowed, otherwise reports how long until the next token is available.
 *
 * Bounded by `maxBuckets` with LRU eviction on insert — mirrors the
 * `EngineStore.cache` pattern in `./engine.ts`. No periodic timer: buckets
 * are pure state with no resource to dispose, and inline eviction at cap
 * is enough. This deliberately sidesteps the `EngineStore.start()`
 * test-leak trap (background `setInterval` per `createApp` accumulating
 * across the suite).
 *
 * Construct once per process; tests can inject `now()` for deterministic
 * advancement and a low `maxBuckets` to exercise eviction without
 * scaling up the fixture.
 */

export interface RateLimitTier {
  /** Maximum tokens a freshly-seen bucket starts with, and the cap
   *  refills never exceed. */
  capacity: number;
  /** Tokens regenerated per second. Bucket size of 120 with
   *  `refillPerSec: 2` = 120 req burst then steady 120/min. */
  refillPerSec: number;
}

export interface ConsumeResult {
  allowed: boolean;
  /** Seconds (real, not rounded) until the bucket holds ≥ 1 token.
   *  `0` when `allowed`. Callers should `Math.ceil` for `Retry-After`. */
  retryAfterSec: number;
}

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

const DEFAULT_MAX_BUCKETS = 10_000;

export class TokenBucketStore {
  private readonly buckets = new Map<string, BucketState>();
  private readonly lastUsedAt = new Map<string, number>();
  private readonly maxBuckets: number;
  private readonly now: () => number;

  constructor(opts: { maxBuckets?: number; now?: () => number } = {}) {
    this.maxBuckets = opts.maxBuckets ?? DEFAULT_MAX_BUCKETS;
    this.now = opts.now ?? Date.now;
  }

  consume(key: string, tier: RateLimitTier): ConsumeResult {
    const nowMs = this.now();
    let state = this.buckets.get(key);
    if (!state) {
      // First contact for this key — full burst available.
      state = { tokens: tier.capacity, lastRefillMs: nowMs };
      this.evictLruIfFull();
      this.buckets.set(key, state);
    } else {
      const elapsedSec = (nowMs - state.lastRefillMs) / 1000;
      // Refill caps at capacity; negative elapsed (clock rewind) is
      // clamped to zero so a backwards-stepping injected clock doesn't
      // mint tokens.
      const refill = Math.max(0, elapsedSec) * tier.refillPerSec;
      state.tokens = Math.min(tier.capacity, state.tokens + refill);
      state.lastRefillMs = nowMs;
    }
    this.lastUsedAt.set(key, nowMs);

    if (state.tokens >= 1) {
      state.tokens -= 1;
      return { allowed: true, retryAfterSec: 0 };
    }
    // Deficit math: tokens are < 1, fractional. Refill needs (1 - tokens)
    // more tokens to allow a request.
    const retryAfterSec = (1 - state.tokens) / tier.refillPerSec;
    return { allowed: false, retryAfterSec };
  }

  size(): number {
    return this.buckets.size;
  }

  clear(): void {
    this.buckets.clear();
    this.lastUsedAt.clear();
  }

  /** Drop the least-recently-used entry until under `maxBuckets`. Called
   *  before inserting a new bucket. Iterates `buckets.keys()` so a stray
   *  `lastUsedAt` entry without a matching bucket can't make this spin
   *  (same defensive pattern as `EngineStore.evictLruIfFull`). */
  private evictLruIfFull(): void {
    while (this.buckets.size >= this.maxBuckets) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const k of this.buckets.keys()) {
        const t = this.lastUsedAt.get(k) ?? -Infinity;
        if (t < oldestTime) {
          oldestTime = t;
          oldestKey = k;
        }
      }
      if (oldestKey === null) break;
      this.buckets.delete(oldestKey);
      this.lastUsedAt.delete(oldestKey);
    }
  }
}
