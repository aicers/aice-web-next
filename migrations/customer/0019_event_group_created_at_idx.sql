-- no-transaction
-- Story streaming cursor support (sub-issue #493 round-4 follow-up).
--
-- The Phase 2 story drain (`POST /api/aimer/phase2/story/next-batch`)
-- selects the next slice of unsent auto-correlated Stories using a
-- `(created_at, id)` cursor — not `(time_window_end, id)`. Cursor by
-- `created_at` (monotonic at insert) closes the late-insert race in
-- which a Story inserted after a slice was loaded but with a
-- `time_window_end` that sorts inside the just-minted range would
-- otherwise live permanently behind the advanced cursor and never be
-- delivered. See `src/lib/aimer/phase2/story-push.ts` for the full
-- rationale.
--
-- Built `CONCURRENTLY` so the live correlator INSERT path stays
-- unblocked while the index is created. `CONCURRENTLY` cannot run
-- inside a transaction, hence the `-- no-transaction` marker on the
-- first line.
--
-- Intentionally omits `IF NOT EXISTS` — see
-- `0006_baseline_raw_score_index.sql` for the rationale: a `CONCURRENTLY`
-- create that is interrupted leaves an invalid index shell with the
-- target name, and `IF NOT EXISTS` would silently skip the rebuild.
-- Loud-failure beats silent-broken-state.

CREATE INDEX CONCURRENTLY event_group_auto_created_at_idx
    ON event_group (created_at, id)
    WHERE kind = 'auto_correlated';
