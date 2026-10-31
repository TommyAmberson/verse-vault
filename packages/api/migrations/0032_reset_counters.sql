-- An account's reset counter (spec 007). Delete all progress and Reset
-- account move it on; progress sent against an older value is refused, so
-- a device that missed a wipe can't bring pre-wipe reviews back. Accounts
-- never wiped have no row and read as 0.
CREATE TABLE `reset_counters` (
	`user_id` text PRIMARY KEY NOT NULL,
	`counter` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
