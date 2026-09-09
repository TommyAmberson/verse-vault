-- Marker table for TS-side data migrations — transformations that need
-- the engine (e.g. #141's legacy→stable card-id translation via the
-- wasm legacy_card_id_map), which pure SQL can't express. Rows are
-- written by lib/data-migrations.ts after a migration completes, making
-- re-runs no-ops. Schema migrations stay in this folder; only
-- engine-dependent data rewrites go through the TS runner.
CREATE TABLE `data_migrations` (
	`id` text PRIMARY KEY NOT NULL,
	`applied_at` integer NOT NULL
);
