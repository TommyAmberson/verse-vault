/**
 * The sync upload's event shapes and how one is read. Shared by the
 * upload route and by repairs, so a repaired event is held to exactly
 * the rules an uploaded one is.
 */

import type { Grade } from './review-log.js';

/** Events with `timestampSecs` more than this far in the future are taken as malformed.
 *  A broken device RTC (BIOS battery dead, etc.) would otherwise wedge the
 *  user's event timeline arbitrarily. */
const CLOCK_SKEW_TOLERANCE_SECS = 24 * 60 * 60;

export interface BaseEventUpload {
  clientEventId: string;
  timestampSecs: number;
  snapshotVersion: number;
}

export interface ReviewEventUpload extends BaseEventUpload {
  /** Optional for backward compat: legacy uploads omit `kind`. */
  kind?: 'review';
  cardId: number;
  grade: Grade;
}

export interface GraduateEventUpload extends BaseEventUpload {
  kind: 'graduate';
  verseId: number;
}

export interface GraduateCardEventUpload extends BaseEventUpload {
  kind: 'graduateCard';
  cardId: number;
}

export type SyncEventUpload = ReviewEventUpload | GraduateEventUpload | GraduateCardEventUpload;

export function eventKind(e: SyncEventUpload): 'review' | 'graduate' | 'graduateCard' {
  return e.kind ?? 'review';
}

/** The identifying fields of an upload, as far as they can be read. A
 *  malformed event may have none of them, and is taken anyway. */
export interface UploadIds {
  clientEventId: string | null;
  kind: string | null;
  timestampSecs: number | null;
}

export type ParsedUpload =
  | (UploadIds & { event: SyncEventUpload; problem?: undefined })
  | (UploadIds & { event?: undefined; problem: string });

export function uploadIds(e: SyncEventUpload): UploadIds {
  return { clientEventId: e.clientEventId, kind: eventKind(e), timestampSecs: e.timestampSecs };
}

/** Read one uploaded event. Anything that fails is still taken, as
 *  `unusable` / `malformed`, with the problem as its reason. */
export function parseUpload(raw: unknown, nowSecs: number): ParsedUpload {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const clientEventId =
    typeof obj.clientEventId === 'string' && obj.clientEventId ? obj.clientEventId : null;
  const kind = obj.kind === undefined ? 'review' : typeof obj.kind === 'string' ? obj.kind : null;
  const timestampSecs = Number.isInteger(obj.timestampSecs) ? (obj.timestampSecs as number) : null;
  const ids: UploadIds = { clientEventId, kind, timestampSecs };
  const fail = (problem: string): ParsedUpload => ({ ...ids, problem });

  if (typeof raw !== 'object' || raw === null) return fail('event must be an object');
  if (clientEventId === null) return fail('clientEventId must be a non-empty string');
  if (timestampSecs === null || timestampSecs < 0) {
    return fail('timestampSecs must be a non-negative integer');
  }
  if (timestampSecs > nowSecs + CLOCK_SKEW_TOLERANCE_SECS) {
    return fail('timestampSecs more than 24h in the future — check device clock');
  }
  if (!Number.isInteger(obj.snapshotVersion) || (obj.snapshotVersion as number) < 1) {
    return fail('snapshotVersion must be a positive integer');
  }
  const nonNegativeInt = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
  if (kind === 'review') {
    if (!nonNegativeInt(obj.cardId)) return fail('cardId must be a non-negative integer');
    if (![1, 2, 3, 4].includes(obj.grade as number)) return fail('grade must be 1..=4');
  } else if (kind === 'graduate') {
    if (!nonNegativeInt(obj.verseId)) return fail('verseId must be a non-negative integer');
  } else if (kind === 'graduateCard') {
    if (!nonNegativeInt(obj.cardId)) return fail('cardId must be a non-negative integer');
  } else {
    return fail(`unknown event kind: ${String(obj.kind)}`);
  }
  return { ...ids, event: raw as SyncEventUpload };
}
