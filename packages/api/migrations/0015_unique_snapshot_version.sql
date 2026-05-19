-- Prevent two concurrent EngineStore.load callers on a stale snapshot
-- from both inserting version=N+1 for the same (user, material). The
-- desc-version pick would otherwise be non-deterministic between the
-- duplicate rows.

CREATE UNIQUE INDEX `uniq_graph_snapshots_user_material_version` ON `graph_snapshots` (`user_id`,`material_id`,`version`);
