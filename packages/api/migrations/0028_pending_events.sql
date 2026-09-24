-- Events the server took but did not apply. Sync never refuses an event
-- (constitution principle VI): one it cannot apply now rests here with
-- its reason, so the device can forget it and the learner's work is on
-- the server, backed up and countable. Kept apart from review_events so
-- replay never has to filter the log. material_id is not a foreign key:
-- a not-enrolled row may name a material the account has no row for.
-- client_event_id, kind and timestamp_secs are nullable because a
-- malformed event is taken too, and may carry none of them.
CREATE TABLE `pending_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`material_id` text NOT NULL,
	`client_event_id` text,
	`kind` text,
	`timestamp_secs` integer,
	`payload_json` text NOT NULL,
	`status` text NOT NULL,
	`reason_code` text NOT NULL,
	`reason` text NOT NULL,
	`received_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_pending_events_user_material_client_event` ON `pending_events` (`user_id`,`material_id`,`client_event_id`);
--> statement-breakpoint
CREATE INDEX `idx_pending_events_user_material_status` ON `pending_events` (`user_id`,`material_id`,`status`);
