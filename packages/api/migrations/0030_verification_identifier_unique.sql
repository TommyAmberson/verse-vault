-- One verification row per identifier. The email-code plugin replaces an
-- older code only when creating the new one fails on this constraint;
-- without it a resend kept both rows, and lookups that take the newest by
-- created_at (whole seconds) could pick either code. Keep the newest of any
-- existing duplicates first.
DELETE FROM `verification` WHERE `rowid` NOT IN (
  SELECT MAX(`rowid`) FROM `verification` GROUP BY `identifier`
);
--> statement-breakpoint
DROP INDEX `idx_verification_identifier`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_verification_identifier` ON `verification` (`identifier`);
