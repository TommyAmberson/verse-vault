-- Pre-refactor enrolment rows hold a `material_data` blob in the legacy
-- shape (text + phrases + ftv) that the new structural-data engine
-- can't parse. test_states reference verse_ids and TestKeys derived
-- from that legacy build, which may not match the structural rebuild.
-- review_events reference card_ids that may or may not survive the
-- rebuild.
--
-- No live users exist (single-developer dogfooding only); purge so the
-- next enrolment seeds fresh against the structural shape.

DELETE FROM review_events;--> statement-breakpoint
DELETE FROM test_states;--> statement-breakpoint
DELETE FROM graph_snapshots;
