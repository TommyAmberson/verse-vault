CREATE TABLE `apibible_passages` (
	`bible_id` text NOT NULL,
	`passage_id` text NOT NULL,
	`content_html` text NOT NULL,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`bible_id`, `passage_id`)
);
--> statement-breakpoint
CREATE TABLE `apibible_sections` (
	`bible_id` text NOT NULL,
	`book_code` text NOT NULL,
	`sections_json` text NOT NULL,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`bible_id`, `book_code`)
);
