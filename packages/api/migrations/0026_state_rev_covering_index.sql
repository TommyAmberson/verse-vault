-- Covering index for the stateRev fingerprint's review_events aggregate
-- (lib/state-rev.ts). The fingerprint runs on every GET /api/years — a
-- per-navigation endpoint — and reads COUNT(*), MAX(timestamp_secs),
-- SUM(timestamp_secs + card_id + grade) per (user, material). The
-- existing idx_review_events_user_material_time lacks card_id/grade, so
-- each call would pay one rowid seek per event, growing linearly with
-- the append-only log (~4x measured at 10k events). With all five
-- columns in the index the whole aggregate is a covering scan.
CREATE INDEX `idx_review_events_state_rev`
ON `review_events` (`user_id`, `material_id`, `timestamp_secs`, `card_id`, `grade`);
