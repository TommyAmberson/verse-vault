-- The picker's shape keeps churning on this branch. Two changes here:
--
-- 1. Drop user_club_status (and its older incarnation user_club_settings).
--    Per-tier status is now derived from year-wide new_scope and
--    review_scope columns on user_year_settings.
-- 2. user_year_settings gains new_scope + review_scope columns.
--
-- These are all transient picker preferences — no review state in any
-- of them — so drop-and-recreate is safe. test_states, graph_snapshots,
-- review_events, and the auth tables are untouched.

DROP TABLE IF EXISTS `user_club_settings`;
--> statement-breakpoint
DROP TABLE IF EXISTS `user_club_status`;
--> statement-breakpoint
DROP TABLE IF EXISTS `user_year_settings`;
--> statement-breakpoint
CREATE TABLE `user_year_settings` (
	`user_id` text NOT NULL,
	`material_id` text NOT NULL,
	`headings` integer NOT NULL,
	`ftv` integer NOT NULL,
	`new_scope` text NOT NULL,
	`review_scope` text NOT NULL,
	`club_card_scope` text NOT NULL,
	`chapter_list_scope` text NOT NULL,
	`lesson_batch_size` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `material_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
