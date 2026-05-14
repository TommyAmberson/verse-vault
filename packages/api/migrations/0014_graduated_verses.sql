CREATE TABLE `graduated_verses` (
	`user_id` text NOT NULL,
	`material_id` text NOT NULL,
	`verse_id` integer NOT NULL,
	`graduated_at_secs` integer NOT NULL,
	PRIMARY KEY(`user_id`, `material_id`, `verse_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
