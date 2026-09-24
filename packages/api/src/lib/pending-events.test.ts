import { afterEach, describe, expect, it } from 'vitest';

import { graduatedCards, pendingEvents } from '../db/schema.js';
import { createTestDb, createTestUser } from '../test-utils.js';
import {
  countForOperator,
  hasPromotable,
  heldClientEventIds,
  markDiscarded,
  rejudgeHeld,
  summariseAwaitingConfirmation,
  take,
  type TakeInput,
} from './pending-events.js';

const KEY = { userId: 'u1', materialId: 'nkjv-john' };
const NOW = 1_790_200_000;

function input(overrides: Partial<TakeInput> = {}): TakeInput {
  return {
    clientEventId: 'e1',
    kind: 'graduateCard',
    timestampSecs: 1_790_000_000,
    payload: { kind: 'graduateCard', cardId: 71 },
    status: 'pending',
    reasonCode: 'card-not-emitted',
    reason: 'card id 71 is not emitted by the current config',
    ...overrides,
  };
}

describe('pending-events', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  function setup() {
    const test = createTestDb();
    cleanup = test.cleanup;
    createTestUser(test.db, KEY.userId);
    return test.db;
  }

  it('stores pending and unusable events with their reasons', () => {
    const db = setup();
    const taken = take(db, KEY, [
      input(),
      input({ clientEventId: 'e2', status: 'unusable', reasonCode: 'card-unknown', reason: 'x' }),
    ], NOW);

    expect(taken).toBe(2);
    const rows = db.select().from(pendingEvents).all();
    expect(rows.map((r) => [r.clientEventId, r.status, r.reasonCode])).toEqual([
      ['e1', 'pending', 'card-not-emitted'],
      ['e2', 'unusable', 'card-unknown'],
    ]);
    expect(JSON.parse(rows[0].payloadJson)).toEqual({ kind: 'graduateCard', cardId: 71 });
    expect(rows[0].receivedAt).toBe(NOW);
  });

  it('reports which client ids are already held, in any status', () => {
    const db = setup();
    take(db, KEY, [
      input({ clientEventId: 'a' }),
      input({ clientEventId: 'b', status: 'unusable', reasonCode: 'card-unknown' }),
      input({ clientEventId: null, reasonCode: 'malformed', status: 'unusable' }),
    ], NOW);
    take(db, { ...KEY, materialId: 'other' }, [input({ clientEventId: 'c' })], NOW);

    expect(heldClientEventIds(db, KEY, ['a', 'b', 'c', 'd'])).toEqual(new Set(['a', 'b']));
    expect(heldClientEventIds(db, KEY, [])).toEqual(new Set());
  });

  it('treats re-taking the same clientEventId as a no-op', () => {
    const db = setup();
    take(db, KEY, [input()], NOW);
    const again = take(db, KEY, [input({ reason: 'second attempt' })], NOW + 60);

    expect(again).toBe(0);
    const rows = db.select().from(pendingEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('card id 71 is not emitted by the current config');
  });

  it('stores every event that carries no clientEventId', () => {
    const db = setup();
    const malformed = input({
      clientEventId: null,
      kind: null,
      timestampSecs: null,
      status: 'unusable',
      reasonCode: 'malformed',
      reason: 'clientEventId must be a non-empty string',
    });
    expect(take(db, KEY, [malformed, malformed], NOW)).toBe(2);
    expect(db.select().from(pendingEvents).all()).toHaveLength(2);
  });

  it('counts by account, material, status and reason code', () => {
    const db = setup();
    createTestUser(db, 'u2');
    take(db, KEY, [input({ clientEventId: 'a' }), input({ clientEventId: 'b' })], NOW);
    take(db, KEY, [
      input({ clientEventId: 'c', status: 'unusable', reasonCode: 'card-unknown' }),
    ], NOW);
    take(db, { userId: 'u2', materialId: 'nkjv-john' }, [input({ clientEventId: 'a' })], NOW);

    const row = (userId: string, status: string, reasonCode: string, count: number) => ({
      userId,
      materialId: 'nkjv-john',
      status,
      reasonCode,
      count,
    });
    expect(countForOperator(db)).toEqual([
      row('u1', 'pending', 'card-not-emitted', 2),
      row('u1', 'unusable', 'card-unknown', 1),
      row('u2', 'pending', 'card-not-emitted', 1),
    ]);
  });

  it('summarises and discards events awaiting confirmation', () => {
    const db = setup();
    const awaiting = (id: string, ts: number) =>
      input({ clientEventId: id, timestampSecs: ts, reasonCode: 'awaiting-confirmation' });
    take(db, KEY, [awaiting('a', 1_790_000_300), awaiting('b', 1_790_000_100), input()], NOW);

    expect(summariseAwaitingConfirmation(db, KEY)).toEqual({
      queuedCount: 2,
      oldestQueuedTs: 1_790_000_100,
    });

    expect(markDiscarded(db, KEY)).toBe(2);
    expect(summariseAwaitingConfirmation(db, KEY)).toBeNull();
    const statuses = db.select().from(pendingEvents).all().map((r) => [r.clientEventId, r.status]);
    expect(statuses).toEqual([
      ['a', 'discarded'],
      ['b', 'discarded'],
      ['e1', 'pending'],
    ]);
  });

  it('applies only rows judged to apply, retiring them in the same transaction', () => {
    const db = setup();
    const card = (id: string, cardId: number) =>
      input({ clientEventId: id, payload: { kind: 'graduateCard', clientEventId: id, cardId } });
    take(db, KEY, [
      card('yes', 1),
      card('no', 2),
      card('gone', 3),
      { ...card('wait', 1), reasonCode: 'awaiting-confirmation' },
    ], NOW);
    const classes = new Map([
      [1, 'emitted'],
      [2, 'not-emitted'],
      [3, 'unknown'],
    ] as const);

    const applied = rejudgeHeld(db, KEY, ['card-not-emitted'], () => classes);

    expect(applied.map((r) => r.clientEventId)).toEqual(['yes']);
    expect(db.select().from(graduatedCards).all().map((r) => r.cardId)).toEqual([1]);
    const left = Object.fromEntries(
      db.select().from(pendingEvents).all().map((r) => [r.clientEventId, r.status]),
    );
    expect(left).toEqual({ no: 'pending', gone: 'unusable', wait: 'pending' });
  });

  it('rolls a re-judge back when it fails part-way', () => {
    const db = setup();
    take(db, KEY, [input({ clientEventId: 'a' }), input({ clientEventId: 'b' })], NOW);

    expect(() =>
      rejudgeHeld(db, KEY, ['card-not-emitted'], () => {
        throw new Error('boom');
      })
    ).toThrow('boom');
    expect(db.select().from(pendingEvents).all()).toHaveLength(2);
  });

  it('reports nothing promotable without a query per row', () => {
    const db = setup();
    take(db, KEY, [input({ status: 'unusable', reasonCode: 'card-unknown' })], NOW);
    expect(hasPromotable(db, KEY, ['card-not-emitted', 'not-enrolled'])).toBe(false);
  });
});
