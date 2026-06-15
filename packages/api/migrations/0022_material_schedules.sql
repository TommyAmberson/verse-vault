-- Per-(user, material) memorize schedule, mirroring the bundled
-- `data/schedules/<deck>-<season>.json` shape. Stored as a single
-- JSON blob: schedules are small (~5 KB), and a "reset to default"
-- action drops the row to fall back to the bundled file.
--
-- Sync semantics: last-write-wins across devices; no event-log
-- replay (the row IS the authoritative state). The API layer
-- invalidates the engine cache on every write so the next
-- `engines.load` re-reads from disk + this table.
CREATE TABLE `material_schedules` (
	`user_id` text NOT NULL,
	`material_id` text NOT NULL,
	`schedule_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `material_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_material_schedules_user` ON `material_schedules` (`user_id`);
