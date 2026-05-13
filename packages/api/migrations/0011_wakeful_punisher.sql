CREATE TABLE `user_year_settings` (
	`user_id` text NOT NULL,
	`material_id` text NOT NULL,
	`headings` integer NOT NULL,
	`ftv` integer NOT NULL,
	`new_scope` text NOT NULL,
	`review_scope` text NOT NULL,
	`club_card_scope` text NOT NULL,
	`chapter_list_scope` text NOT NULL,
	`lesson_batch_size` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `material_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
