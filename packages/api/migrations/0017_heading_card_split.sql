-- Split the legacy `headings` toggle into two independent fields and
-- reset everyone to the new defaults:
--
--   * `heading_card`         — per-verse "which heading is this verse in?"
--                              prompt (the old VerseInHeading card).
--                              Renamed from `headings`, then UPDATE-reset
--                              to 0 so every existing user gets the new
--                              "off by default" behaviour. Users who want
--                              the per-verse card can re-enable it from
--                              the settings UI; the new design treats it
--                              as opt-in.
--   * `heading_passage_card` — per-heading "what heading is this whole
--                              passage under?" prompt (the new HeadingPassage
--                              card). Defaults to 1 (on) — the passage-cued
--                              card is the primary heading test in the new
--                              design.
--
-- See core 0.2.0 CHANGELOG for the algorithm side of the split.
ALTER TABLE `user_year_settings` RENAME COLUMN `headings` TO `heading_card`;
--> statement-breakpoint
ALTER TABLE `user_year_settings` ADD COLUMN `heading_passage_card` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
UPDATE `user_year_settings` SET `heading_card` = 0;
