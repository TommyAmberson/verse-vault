-- Per-card graduation log. Cards reach `Active` either through the
-- bulk-flip path (`graduate_verse` flips the unconditional verse-bound
-- kinds) or through this per-card path: HeadingPassage, ChapterClubList,
-- and the conditional verse-bound kinds (Ftv, VerseInHeading,
-- VerseInClub) all graduate individually via `graduate_card`. On engine
-- load we replay both tables so a fresh engine matches the user's
-- progress regardless of which path each card took.
CREATE TABLE `graduated_cards` (
	`user_id` text NOT NULL,
	`material_id` text NOT NULL,
	`card_id` integer NOT NULL,
	`graduated_at_secs` integer NOT NULL,
	PRIMARY KEY(`user_id`, `material_id`, `card_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
