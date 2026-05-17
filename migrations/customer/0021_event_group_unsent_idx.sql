-- no-transaction
-- Story streaming late-commit straggler-scan index (sub-issue #493
-- round-5 follow-up).
--
-- Supports the per-drain straggler scan in
-- `src/lib/aimer/phase2/story-push.ts::loadStoryStragglerSlice` —
-- a `(created_at, id)` range scan restricted to rows that have NOT
-- been delivered yet. Once a Story's β columns are bumped on ack
-- (`last_sent_at` is set), it drops out of this partial index and is
-- never re-considered. The narrower partial predicate vs.
-- `event_group_auto_created_at_idx` (`0019`) keeps the straggler scan
-- O(unsent rows in window) rather than O(all auto rows in window),
-- which matters on tenants with deep auto-correlated history but a
-- small steady-state unsent backlog.
--
-- Built `CONCURRENTLY` so the live correlator INSERT path stays
-- unblocked. `CONCURRENTLY` cannot run inside a transaction — hence the
-- `-- no-transaction` marker on the first line.
--
-- Intentionally omits `IF NOT EXISTS` — see
-- `0006_baseline_raw_score_index.sql` for the rationale: a
-- `CONCURRENTLY` create that is interrupted leaves an invalid index
-- shell with the target name, and `IF NOT EXISTS` would silently skip
-- the rebuild. Loud-failure beats silent-broken-state.

CREATE INDEX CONCURRENTLY event_group_auto_unsent_created_at_idx
    ON event_group (created_at, id)
    WHERE kind = 'auto_correlated' AND last_sent_at IS NULL;
