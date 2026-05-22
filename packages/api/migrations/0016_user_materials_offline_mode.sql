-- Per-(user, material) toggle for the opt-in bulk-renders download.
-- When true, the client has pre-fetched the deck's composed HTML into
-- IDB and can study offline. Gates `GET /materials/:id/renders` so the
-- only path to a bulk fetch goes through an explicit user choice, per
-- the API.Bible MAUA bulk-extraction clause.

ALTER TABLE `user_materials` ADD COLUMN `offline_mode` integer DEFAULT 0 NOT NULL;
