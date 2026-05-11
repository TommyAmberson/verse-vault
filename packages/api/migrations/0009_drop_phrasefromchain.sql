-- The `PhraseFromChain` TestKind was merged into `PhraseFromContext` —
-- both Recitation and Ftv composites now decompose to the same per-
-- phrase atomic test that PhraseFill exercises. Existing rows tagged
-- `PhraseFromChain` would fail to deserialise on the next engine load
-- (the variant is gone), so drop them. PhraseFromContext rows for the
-- same (verse, position) survive untouched, so users keep their per-
-- phrase memory.

DELETE FROM test_states WHERE test_kind = 'PhraseFromChain';
