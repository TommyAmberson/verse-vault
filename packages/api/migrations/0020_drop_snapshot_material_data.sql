-- Drop the duplicated material_data BLOB from graph_snapshots; replace with
-- content_sha for bump detection. MaterialData is now loaded from disk on
-- every engine build (via getMaterialJson) — the DB never needed N copies of
-- the same blob, one per enrolled user.
--
-- Existing rows are backfilled with a placeholder sha; the first
-- EngineStore.load against each row will detect the mismatch against the
-- actual disk SHA and trigger a bump-on-load that writes the real sha.
CREATE TABLE `graph_snapshots_new` (
    `id` text PRIMARY KEY NOT NULL,
    `user_id` text NOT NULL,
    `material_id` text NOT NULL,
    `version` integer NOT NULL,
    `content_sha` text NOT NULL,
    `created_at` integer NOT NULL,
    FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `graph_snapshots_new` (`id`, `user_id`, `material_id`, `version`, `content_sha`, `created_at`)
SELECT `id`, `user_id`, `material_id`, `version`, 'pre-content-sha-migration', `created_at`
FROM `graph_snapshots`;
--> statement-breakpoint
DROP TABLE `graph_snapshots`;
--> statement-breakpoint
ALTER TABLE `graph_snapshots_new` RENAME TO `graph_snapshots`;
--> statement-breakpoint
CREATE INDEX `idx_graph_snapshots_user_material` ON `graph_snapshots` (`user_id`,`material_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_graph_snapshots_user_material_version` ON `graph_snapshots` (`user_id`,`material_id`,`version`);
