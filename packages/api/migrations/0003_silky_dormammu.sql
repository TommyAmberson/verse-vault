CREATE INDEX `idx_account_provider` ON `account` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE INDEX `idx_verification_identifier` ON `verification` (`identifier`);