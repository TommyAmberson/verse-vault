-- Rename three material ids in the catalog to drop redundant suffixes:
--   nkjv-1cor       → nkjv-cor       (material covers 1–2 Corinthians, not just 1)
--   nkjv-nt-survey  → nkjv-nt
--   nkjv-ot-survey  → nkjv-ot
--
-- Any per-user rows referencing the old ids in this dev DB get rewritten
-- so existing review state, settings, and snapshots stay attached.
-- Production rollouts would normally hit zero rows for two of the three;
-- each statement is a no-op in that case.

UPDATE `user_materials`     SET `material_id` = 'nkjv-cor' WHERE `material_id` = 'nkjv-1cor';
--> statement-breakpoint
UPDATE `user_materials`     SET `material_id` = 'nkjv-nt'  WHERE `material_id` = 'nkjv-nt-survey';
--> statement-breakpoint
UPDATE `user_materials`     SET `material_id` = 'nkjv-ot'  WHERE `material_id` = 'nkjv-ot-survey';
--> statement-breakpoint
UPDATE `graph_snapshots`    SET `material_id` = 'nkjv-cor' WHERE `material_id` = 'nkjv-1cor';
--> statement-breakpoint
UPDATE `graph_snapshots`    SET `material_id` = 'nkjv-nt'  WHERE `material_id` = 'nkjv-nt-survey';
--> statement-breakpoint
UPDATE `graph_snapshots`    SET `material_id` = 'nkjv-ot'  WHERE `material_id` = 'nkjv-ot-survey';
--> statement-breakpoint
UPDATE `review_events`      SET `material_id` = 'nkjv-cor' WHERE `material_id` = 'nkjv-1cor';
--> statement-breakpoint
UPDATE `review_events`      SET `material_id` = 'nkjv-nt'  WHERE `material_id` = 'nkjv-nt-survey';
--> statement-breakpoint
UPDATE `review_events`      SET `material_id` = 'nkjv-ot'  WHERE `material_id` = 'nkjv-ot-survey';
--> statement-breakpoint
UPDATE `test_states`        SET `material_id` = 'nkjv-cor' WHERE `material_id` = 'nkjv-1cor';
--> statement-breakpoint
UPDATE `test_states`        SET `material_id` = 'nkjv-nt'  WHERE `material_id` = 'nkjv-nt-survey';
--> statement-breakpoint
UPDATE `test_states`        SET `material_id` = 'nkjv-ot'  WHERE `material_id` = 'nkjv-ot-survey';
--> statement-breakpoint
UPDATE `user_year_settings` SET `material_id` = 'nkjv-cor' WHERE `material_id` = 'nkjv-1cor';
--> statement-breakpoint
UPDATE `user_year_settings` SET `material_id` = 'nkjv-nt'  WHERE `material_id` = 'nkjv-nt-survey';
--> statement-breakpoint
UPDATE `user_year_settings` SET `material_id` = 'nkjv-ot'  WHERE `material_id` = 'nkjv-ot-survey';
