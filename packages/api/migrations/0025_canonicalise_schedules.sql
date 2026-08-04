-- Rewrite stored v1 schedules into canonical v2 form (#103).
--
-- Writes canonicalise from api 0.1.34 onward, but a row saved before
-- that stays v1 until its owner happens to re-save the schedule — which
-- most never will. Leaving the column mixed keeps every reader folding
-- v1 independently, and those folds have already drifted from each
-- other once (a review week's passage survived the server's fold and
-- vanished in the browser's). Converging storage removes that class of
-- bug. The input-side folds stay: a v1 body is still accepted on PUT,
-- and an account export taken before #103 can still carry one.
--
-- The fold matches `migrateV1Week` and core's `ScheduleWeekRaw`: an
-- existing non-empty `blocks` wins, otherwise a week's passage becomes
-- a one-entry `blocks[]` regardless of `isReview`, and a week with
-- neither gets `blocks: []`. The legacy `passage`/`verses` keys are
-- dropped either way. A v1 week may omit `verses`, so the empty club
-- lists are supplied explicitly rather than left to a reader's default.
--
-- Whole-row guards: rows already at version 2 don't match, and a row
-- whose `schedule_json` isn't valid JSON or whose `weeks` isn't an
-- array is skipped — `json_each` over a non-array yields no rows, and
-- `json_group_array` would then replace the weeks with `[]`. The
-- version guard also makes this idempotent.
--
-- Per-week guard: a week that isn't an object, or whose `passage` /
-- `verses` is some type the fold can't consume (a bare string, say),
-- disqualifies its whole row. `blocks` needs no such check — a
-- non-array one simply fails the first CASE arm and the week folds from
-- its passage, which is what `migrateV1Week`'s `Array.isArray` does too. Those payloads are rare but reachable —
-- review weeks went unvalidated on PUT until 0.1.34, and the route
-- stored request bodies verbatim before it. Skipping keeps such a row
-- exactly as it was: it is already unreadable to the engine, and the
-- alternative is `json()` raising `malformed JSON` mid-statement, which
-- aborts the migration, kills boot, and repeats on every restart —
-- turning one user's bad row into a dead API for everyone.
--
-- To find what was left behind, mind that the obvious query trips over
-- the same rows this skips: `json_extract` raises on the invalid-JSON
-- ones. Guard it:
--
--   SELECT user_id, material_id FROM material_schedules
--   WHERE NOT json_valid(schedule_json)
--      OR json_extract(schedule_json, '$.version') <> 2;
UPDATE `material_schedules`
SET `schedule_json` = json_set(
  `schedule_json`,
  '$.version',
  2,
  '$.weeks',
  (
    SELECT json_group_array(
      json_remove(
        json_set(
          `w`.`value`,
          -- A v1 week may omit `isReview`; every reader defaults it to
          -- false, so write it explicitly rather than leaving the
          -- canonical form dependent on that default.
          '$.isReview',
          CASE WHEN json_extract(`w`.`value`, '$.isReview') = 1 THEN json('true') ELSE json('false') END,
          '$.blocks',
          CASE
            WHEN json_type(`w`.`value`, '$.blocks') = 'array'
              AND json_array_length(`w`.`value`, '$.blocks') > 0
              THEN json_extract(`w`.`value`, '$.blocks')
            WHEN json_type(`w`.`value`, '$.passage') = 'object'
              THEN json_array(
                json_object(
                  'passage',
                  json_extract(`w`.`value`, '$.passage'),
                  'verses',
                  CASE
                    WHEN json_type(`w`.`value`, '$.verses') = 'object'
                      THEN json_extract(`w`.`value`, '$.verses')
                    ELSE json('{"club150":[],"club300":[]}')
                  END
                )
              )
            ELSE json_array()
          END
        ),
        '$.passage',
        '$.verses'
      )
    )
    FROM json_each(json_extract(`schedule_json`, '$.weeks')) AS `w`
  )
)
WHERE json_valid(`schedule_json`)
  AND json_extract(`schedule_json`, '$.version') = 1
  AND json_type(`schedule_json`, '$.weeks') = 'array'
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(json_extract(`schedule_json`, '$.weeks')) AS `bad`
    -- `bad`.`type` is json_each's own column, not a re-parse: for a week
    -- that isn't an object, `bad`.`value` is raw SQL text and feeding it
    -- back to `json_type` would itself raise `malformed JSON`. The CASE
    -- keeps the per-field checks from evaluating in that case.
    WHERE CASE
      WHEN `bad`.`type` = 'object' THEN
        json_type(`bad`.`value`, '$.passage') NOT IN ('object', 'null')
        OR json_type(`bad`.`value`, '$.verses') NOT IN ('object', 'null')
      ELSE 1
    END
  );
