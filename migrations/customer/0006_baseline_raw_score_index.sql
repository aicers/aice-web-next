-- no-transaction
-- Baseline algorithm PR 1: per-cohort raw_score btree index.
--
-- Required by RFC 0001 §11 (slider movement) and §9 schema requirements.
-- Column order is dictated by the planner's index-resolution rules:
--   * `kind` (equality)            — first
--   * `baseline_version` (equality) — second so cross-version comparisons
--                                     never re-enter (RFC 0001 §3)
--   * `raw_score DESC` (range)     — third so the cutoff stays
--                                     index-resolved at slider stops
--   * `event_time DESC` (residual) — last, used for in-cohort ordering
--
-- Putting `event_time` before `raw_score` would block index resolution of
-- the range cutoff: a range column at position N stops the planner from
-- using index columns N+1 onward for further range filtering.
--
-- Runs `CONCURRENTLY` so the live cadence INSERT path is not blocked while
-- the index is built. `CONCURRENTLY` cannot run inside a transaction, so
-- this file carries the `-- no-transaction` marker on line 1 and ships as
-- a single statement per the migrations/README.md "one statement per file"
-- convention for no-transaction migrations.

CREATE INDEX CONCURRENTLY IF NOT EXISTS baseline_triaged_event_kind_version_raw_score_event_time_idx
    ON baseline_triaged_event (kind, baseline_version, raw_score DESC, event_time DESC);
