-- 0007 purges review_events / test_states / graph_snapshots but on
-- existing dev DBs it ran before user_materials was added to the purge
-- list. Those rows are now orphans (no matching graph_snapshot), and
-- the PK guard in enrollUser maps them to AlreadyEnrolledError (HTTP
-- 409), so /api/cards/:id then trips NotEnrolled (HTTP 404) since the
-- snapshot is gone. Net effect: the user is locked out.
--
-- Clear only the orphan rows so anyone who's properly enrolled keeps
-- their snapshot. On fresh DBs (where 0007 already includes the
-- user_materials DELETE) this is a no-op.

DELETE FROM user_materials
WHERE NOT EXISTS (
  SELECT 1 FROM graph_snapshots gs
  WHERE gs.user_id = user_materials.user_id
    AND gs.material_id = user_materials.material_id
);
