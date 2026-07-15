-- Backfill `graduated_verses` from review evidence (#111).
--
-- History predating the event-sourced graduation log has test states
-- but no graduation rows. Cards rebuilt from MaterialData default to
-- `New` and only flip `Active` via the graduation replay, so a year
-- with reviewed test states but no graduations is silently
-- unreviewable everywhere (client and server engines read the same
-- tables).
--
-- Evidence rule, two conditions both required:
--
-- 1. Kind: a `PhraseFromContext` row belongs to the verse's own
--    content cards — PhraseFill/Recitation/Ftv are the only emitters,
--    each servable only after the verse (or its Ftv card) graduated.
--    Multi-verse kinds are NOT safe evidence: HeadingPassage and
--    ChapterClubList cards write `VerseHeading`/`VerseClub` rows
--    carrying OTHER verses' ids. Per-card graduations
--    (`graduated_cards`) are left alone for the same reason; affected
--    HP/CCL/conditional cards resurface in the memorize queue and
--    re-graduate organically.
--
-- 2. Reviewed, not merely seeded: `enrollUser` (and every
--    `rebuildFromEvents`) persists the engine's FULL test-state
--    catalogue — one `TestState::new_unseen` row per reachable test,
--    covering every verse of the material before the user has done
--    anything. Those pristine seeds carry an exact signature
--    (stability 1.0, difficulty 5.0, all three timestamps equal at
--    enrollment minus 365 d) that no reviewed row retains: FSRS never
--    reproduces the exact seed constants and any grade moves
--    `last_seen_secs` to the review time. Without this exclusion the
--    backfill would graduate every verse of every enrolled material
--    for every user.
--
-- `graduated_at_secs` takes the earliest REVIEWED sighting as a
-- best-effort timestamp (seed timestamps are excluded above, so the
-- enrollment-minus-a-year sentinel can't leak in). Idempotent:
-- re-runs and rows that already exist are no-ops via
-- ON CONFLICT DO NOTHING.
INSERT INTO `graduated_verses` (`user_id`, `material_id`, `verse_id`, `graduated_at_secs`)
SELECT
  `user_id`,
  `material_id`,
  json_extract(`element`, '$.verse_id') AS `verse_id`,
  MIN(`last_seen_secs`)
FROM `test_states`
WHERE `test_kind` = 'PhraseFromContext'
  AND json_extract(`element`, '$.verse_id') IS NOT NULL
  AND NOT (
    `stability` = 1.0
    AND `difficulty` = 5.0
    AND `last_seen_secs` = `last_base_secs`
    AND `last_base_secs` = `last_root_secs`
  )
  -- Orphan guard: a test_states row whose user vanished (external
  -- tooling with FKs off) would otherwise abort the whole migration —
  -- and boot — with an FK violation that ON CONFLICT doesn't cover.
  AND `user_id` IN (SELECT `id` FROM `user`)
GROUP BY `user_id`, `material_id`, `verse_id`
ON CONFLICT DO NOTHING;
