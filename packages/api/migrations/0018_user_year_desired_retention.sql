-- Per-(user, material) FSRS target retention. Was hardcoded at 0.9 in the
-- API's `DEFAULT_DESIRED_RETENTION`; now persisted per row so the user can
-- tune memory↔workload via the settings UI. Bounded to [0.7, 0.97] at
-- the API layer (FSRS-author recommendation: above 0.97 explodes review
-- count for marginal recall gains; below 0.7 lets too much fade).
ALTER TABLE `user_year_settings` ADD COLUMN `desired_retention` real DEFAULT 0.9 NOT NULL;
