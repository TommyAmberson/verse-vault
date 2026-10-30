-- One user per sign-in identity. Linking a Google account checks that no
-- one else holds it, then writes the link; two links racing for the same
-- Google account could both pass the check and attach it to two users.
-- Unique, the second write fails instead. Fails to apply, rather than
-- picking a winner, if duplicates already exist.
DROP INDEX `idx_account_provider`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_account_provider` ON `account` (`provider_id`, `account_id`);
