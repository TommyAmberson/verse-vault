CREATE TABLE `card_states` (
	`user_id` text NOT NULL,
	`material_id` text NOT NULL,
	`card_id` integer NOT NULL,
	`state` text NOT NULL,
	`due_r` real,
	`due_date_secs` integer,
	`priority` real,
	PRIMARY KEY(`user_id`, `material_id`, `card_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `edge_states` (
	`user_id` text NOT NULL,
	`material_id` text NOT NULL,
	`edge_id` integer NOT NULL,
	`stability` real NOT NULL,
	`difficulty` real NOT NULL,
	`last_review_secs` integer NOT NULL,
	PRIMARY KEY(`user_id`, `material_id`, `edge_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `graph_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`material_id` text NOT NULL,
	`version` integer NOT NULL,
	`graph_data` blob NOT NULL,
	`cards_data` blob NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `review_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`material_id` text NOT NULL,
	`snapshot_version` integer NOT NULL,
	`timestamp_secs` integer NOT NULL,
	`card_id` integer,
	`shown` blob NOT NULL,
	`hidden` blob NOT NULL,
	`grades` blob NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `user_materials` (
	`user_id` text NOT NULL,
	`material_id` text NOT NULL,
	`club_tier` integer,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `material_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
