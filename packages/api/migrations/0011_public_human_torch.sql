CREATE TABLE `user_club_settings` (
	`user_id` text NOT NULL,
	`material_id` text NOT NULL,
	`club_tier` text NOT NULL,
	`status` text NOT NULL,
	`club_cards` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `material_id`, `club_tier`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_year_settings` (
	`user_id` text NOT NULL,
	`material_id` text NOT NULL,
	`headings` integer NOT NULL,
	`ftv` integer NOT NULL,
	`lesson_batch_size` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `material_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
