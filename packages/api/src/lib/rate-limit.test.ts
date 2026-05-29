import { describe, expect, it } from 'vitest';

import { type RateLimitTier, TokenBucketStore } from './rate-limit.js';

// Tight tier so test assertions are simple — capacity 3, refill 1 token/sec.
const TIER: RateLimitTier = { capacity: 3, refillPerSec: 1 };

describe('TokenBucketStore', () => {
  it('allows consumption up to capacity on first contact', () => {
    let clock = 0;
    const s = new TokenBucketStore({ now: () => clock });
    for (let i = 0; i < TIER.capacity; i++) {
      expect(s.consume('k', TIER).allowed).toBe(true);
    }
  });

  it('denies past capacity and reports retryAfterSec via deficit math', () => {
    let clock = 0;
    const s = new TokenBucketStore({ now: () => clock });
    for (let i = 0; i < TIER.capacity; i++) s.consume('k', TIER);
    const denied = s.consume('k', TIER);
    expect(denied.allowed).toBe(false);
    // After draining, deficit is 1 token; refill 1/sec → retry in 1 sec.
    expect(denied.retryAfterSec).toBeCloseTo(1, 6);
  });

  it('refills tokens proportionally to advanced clock', () => {
    let clock = 0;
    const s = new TokenBucketStore({ now: () => clock });
    for (let i = 0; i < TIER.capacity; i++) s.consume('k', TIER);
    clock = 2_000; // 2 seconds → 2 tokens refilled
    expect(s.consume('k', TIER).allowed).toBe(true);
    expect(s.consume('k', TIER).allowed).toBe(true);
    expect(s.consume('k', TIER).allowed).toBe(false);
  });

  it('caps refill at capacity (no overflow on long idle)', () => {
    let clock = 0;
    const s = new TokenBucketStore({ now: () => clock });
    s.consume('k', TIER); // 2 tokens left
    clock = 10_000_000; // idle for ages — would refill way past capacity
    for (let i = 0; i < TIER.capacity; i++) {
      expect(s.consume('k', TIER).allowed).toBe(true);
    }
    // Capacity is the ceiling — the 4th request fails.
    expect(s.consume('k', TIER).allowed).toBe(false);
  });

  it('keys are independent', () => {
    let clock = 0;
    const s = new TokenBucketStore({ now: () => clock });
    for (let i = 0; i < TIER.capacity; i++) s.consume('a', TIER);
    expect(s.consume('a', TIER).allowed).toBe(false);
    // Different key starts fresh at full capacity.
    expect(s.consume('b', TIER).allowed).toBe(true);
  });

  it('evicts the least-recently-used bucket when over maxBuckets', () => {
    let clock = 0;
    const s = new TokenBucketStore({ now: () => clock, maxBuckets: 2 });
    clock = 100;
    s.consume('a', TIER);
    clock = 200;
    s.consume('b', TIER);
    clock = 300;
    // Inserting c would push above the cap → a (lastUsed=100) gets evicted.
    s.consume('c', TIER);
    expect(s.size()).toBe(2);

    // Drain a's deficit had it survived; instead it gets a fresh bucket.
    for (let i = 0; i < TIER.capacity; i++) {
      expect(s.consume('a', TIER).allowed).toBe(true);
    }
    expect(s.consume('a', TIER).allowed).toBe(false);
  });

  it('clamps clock-rewind so a backwards-stepping injected now() does not mint tokens', () => {
    let clock = 1000;
    const s = new TokenBucketStore({ now: () => clock });
    for (let i = 0; i < TIER.capacity; i++) s.consume('k', TIER);
    clock = 0; // rewind
    // Without the Math.max(0, elapsed) clamp this would mint negative-elapsed
    // tokens; with the clamp the bucket stays empty.
    expect(s.consume('k', TIER).allowed).toBe(false);
  });

  it('clear() empties the store', () => {
    const s = new TokenBucketStore();
    s.consume('a', TIER);
    s.consume('b', TIER);
    expect(s.size()).toBe(2);
    s.clear();
    expect(s.size()).toBe(0);
  });
});
