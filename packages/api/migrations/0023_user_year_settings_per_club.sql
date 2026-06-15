-- Phase 1 of the schedules + per-club settings rework.
--
-- Adds `config_json` to `user_year_settings` storing the new per-club
-- shape as a JSON blob (memorize/review/moveToNext maps + the existing
-- card-kind toggles). The legacy flat columns (`new_scope`,
-- `review_scope`, `desired_retention`, `lesson_batch_size`, etc.) stay
-- for one release so the route layer can dual-write during transition;
-- a future migration drops them once Phase 2's web UI ships.
--
-- The UPDATE materialises `config_json` from the legacy columns per the
-- spec's migration table:
--   new_scope = Off    → every memorize.{club}.enabled = false
--   new_scope = Up150  → only memorize.club150.enabled = true
--   new_scope = Up300  → memorize.club150 + memorize.club300 enabled
--   new_scope = All    → all three memorize clubs enabled
--   review_scope       → same mapping for review.{club}.enabled
--   desired_retention  → applied to every enabled review club,
--                        clamped to the new [0.5, 0.9] range
--   move_to_next       → CaughtUp on every pair (new default)
--   catch_up per club  → Sequential on every club (new default)
ALTER TABLE `user_year_settings` ADD COLUMN `config_json` text;
--> statement-breakpoint
UPDATE `user_year_settings` SET `config_json` = json_object(
    'headingCard',         CASE WHEN heading_card = 1 THEN json('true') ELSE json('false') END,
    'headingPassageCard',  CASE WHEN heading_passage_card = 1 THEN json('true') ELSE json('false') END,
    'ftv',                 CASE WHEN ftv = 1 THEN json('true') ELSE json('false') END,
    'clubCardScope',       club_card_scope,
    'chapterListScope',    chapter_list_scope,
    'lessonBatchSize',     lesson_batch_size,
    'memorize', json_object(
        'club150', json_object(
            'enabled', CASE WHEN new_scope IN ('up150','up300','all') THEN json('true') ELSE json('false') END,
            'catchUp', 'sequential'
        ),
        'club300', json_object(
            'enabled', CASE WHEN new_scope IN ('up300','all') THEN json('true') ELSE json('false') END,
            'catchUp', 'sequential'
        ),
        'full', json_object(
            'enabled', CASE WHEN new_scope = 'all' THEN json('true') ELSE json('false') END,
            'catchUp', 'sequential'
        )
    ),
    'review', json_object(
        'club150', json_object(
            'enabled', CASE WHEN review_scope IN ('up150','up300','all') THEN json('true') ELSE json('false') END,
            'desiredRetention', min(0.9, max(0.5, desired_retention))
        ),
        'club300', json_object(
            'enabled', CASE WHEN review_scope IN ('up300','all') THEN json('true') ELSE json('false') END,
            'desiredRetention', min(0.9, max(0.5, desired_retention))
        ),
        'full', json_object(
            'enabled', CASE WHEN review_scope = 'all' THEN json('true') ELSE json('false') END,
            'desiredRetention', min(0.9, max(0.5, desired_retention))
        )
    ),
    'moveToNext', json_object(
        'p150To300', 'caughtUp',
        'p300ToFull', 'caughtUp'
    )
);
