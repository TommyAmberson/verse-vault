-- Add `pending_relearn` to `test_states` (relearning priority lane state).
-- Wipe every per-user table so the builder's switch from CardState::Active
-- to CardState::New takes effect: all existing decks were built before the
-- switch and have stale Active-state cards in their snapshots. Pre-deploy,
-- no production users; the next sync replays a freshly-built deck.
-- Each DELETE is a no-op on an empty fresh DB.

ALTER TABLE `test_states` ADD COLUMN `pending_relearn` INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
DELETE FROM `test_states`;
--> statement-breakpoint
DELETE FROM `graph_snapshots`;
--> statement-breakpoint
DELETE FROM `review_events`;
--> statement-breakpoint
DELETE FROM `user_year_settings`;
--> statement-breakpoint
DELETE FROM `user_materials`;
