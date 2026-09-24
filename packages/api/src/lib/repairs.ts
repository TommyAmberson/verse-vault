/**
 * Repairs: shipped fixes for events sync took but could not use.
 *
 * An `unusable` event (malformed, or naming a card no config emits) is
 * kept rather than dropped so that it can come back when someone works
 * out what it should have been. A repair is that knowledge, as code: it
 * takes the stored event and returns a rewritten one, or `null` when it
 * does not apply. Engine build tries every shipped repair, in order, on
 * each unusable row the current set has not seen, and keeps the first
 * output that is a well-formed event whose card some config emits. The
 * row then goes through promotion like any held event, at its recorded
 * time. See specs/002-resilient-sync-ingest/research.md, D9.
 *
 * To ship one, append it to `REPAIRS`. Rules:
 *
 * * `id` is permanent. It is written into every row the repair changes
 *   and into the epoch that stops rows being retried, so reusing or
 *   renaming an id re-runs or orphans history.
 * * Be pure and deterministic. A repair runs inside an engine build and
 *   may run again on a later build for rows it has not seen.
 * * Do not change a `clientEventId` the event already has; one assigned
 *   to an event that had none must be unused. The engine rejects outputs
 *   that break either rule.
 * * Return `null` for anything not recognised. A repair that throws is
 *   logged and skipped, never allowed to fail the build.
 *
 * Discarded events are never offered to a repair: discarding was the
 * learner's decision, not a defect.
 */

import type { WasmEngine } from 'verse-vault-wasm';

import type { UserMaterial } from './keys.js';

export interface RepairContext {
  key: UserMaterial;
  /** The learner's engine under their current config. */
  engine: WasmEngine;
}

export interface Repair {
  /** Permanent, unique identifier. Never reuse or rename one. */
  id: string;
  /** What the repair fixes and why, for operators reading `repaired_by`. */
  description: string;
  /** The rewritten event, or `null` when this repair does not apply.
   *  `payload` is a copy; mutating it has no effect on the stored row. */
  repair(payload: unknown, ctx: RepairContext): unknown;
}

/** The shipped repairs, tried in this order. Empty until the first one
 *  ships; an empty list still records its epoch, once, on each row. */
export const REPAIRS: readonly Repair[] = [];

/** Fingerprint of a set of repairs. A row whose `repair_epoch` matches
 *  the shipped set has already been offered every repair in it. */
export function repairEpoch(repairs: readonly Repair[]): string {
  return JSON.stringify(repairs.map((r) => r.id));
}
