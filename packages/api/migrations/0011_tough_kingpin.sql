-- The material picker's shape churned several times on this feature
-- branch. Earlier dev iterations created `user_club_settings` (with
-- club_cards / chapter_lists columns) and a `user_year_settings`
-- carrying the now-defunct `citation` column. None of those rows hold
-- review state — they're just the user's transient picker preferences —
-- so this migration drops and recreates both tables. `test_states`,
-- `graph_snapshots`, `review_events`, and the auth tables are untouched.

DROP TABLE IF EXISTS `user_club_settings`;
--> statement-breakpoint
DROP TABLE IF EXISTS `user_club_status`;
--> statement-breakpoint
CREATE TABLE `user_club_status` (
	`user_id` text NOT NULL,
	`material_id` text NOT NULL,
	`club_tier` text NOT NULL,
	`status` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `material_id`, `club_tier`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
DROP TABLE IF EXISTS `user_year_settings`;
--> statement-breakpoint
CREATE TABLE `user_year_settings` (
	`user_id` text NOT NULL,
	`material_id` text NOT NULL,
	`headings` integer NOT NULL,
	`ftv` integer NOT NULL,
	`club_card_scope` text NOT NULL,
	`chapter_list_scope` text NOT NULL,
	`lesson_batch_size` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `material_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
