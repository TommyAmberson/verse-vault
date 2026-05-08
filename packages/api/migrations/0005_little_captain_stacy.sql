-- HSRS single-grade rewrite. The old multi-grade pipeline tracked memory on
-- (edge_states, card_states); the new core puts FSRS state on per-test
-- elements. Drops the obsolete tables and the shown/hidden/grades blob
-- columns from review_events, then creates test_states. graph_snapshots
-- collapses graph_data + cards_data into a single material_data blob.
--
-- No production users → no data migration; existing rows are dropped.

DROP TABLE IF EXISTS `card_states`;--> statement-breakpoint
DROP TABLE IF EXISTS `edge_states`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_review_events_user_material_time`;--> statement-breakpoint
DROP INDEX IF EXISTS `uniq_review_events_user_material_client_event`;--> statement-breakpoint
DROP TABLE IF EXISTS `review_events`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_graph_snapshots_user_material`;--> statement-breakpoint
DROP TABLE IF EXISTS `graph_snapshots`;--> statement-breakpoint

CREATE TABLE `graph_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`material_id` text NOT NULL,
	`version` integer NOT NULL,
	`material_data` blob NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_graph_snapshots_user_material` ON `graph_snapshots` (`user_id`,`material_id`);--> statement-breakpoint

CREATE TABLE `review_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`material_id` text NOT NULL,
	`snapshot_version` integer NOT NULL,
	`timestamp_secs` integer NOT NULL,
	`card_id` integer NOT NULL,
	`grade` integer NOT NULL,
	`client_event_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_review_events_user_material_time` ON `review_events` (`user_id`,`material_id`,`timestamp_secs`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_review_events_user_material_client_event` ON `review_events` (`user_id`,`material_id`,`client_event_id`);--> statement-breakpoint

CREATE TABLE `test_states` (
	`user_id` text NOT NULL,
	`material_id` text NOT NULL,
	`test_kind` text NOT NULL,
	`element` text NOT NULL,
	`stability` real NOT NULL,
	`difficulty` real NOT NULL,
	`last_seen_secs` integer NOT NULL,
	`last_base_secs` integer NOT NULL,
	`last_root_secs` integer NOT NULL,
	PRIMARY KEY(`user_id`, `material_id`, `test_kind`, `element`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
