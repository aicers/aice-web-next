-- Baseline algorithm PR 1: schema expand for §9 (RFC 0001).
--
-- Adds the nullable `raw_score` column and tightens `selector_tags`
-- with a `'{}'` default. Companion migration `0006_baseline_raw_score_index.sql`
-- adds the supporting btree index outside a transaction
-- (`CREATE INDEX CONCURRENTLY` cannot run inside `BEGIN`/`COMMIT`); the two
-- files together complete the expand half of the expand/contract pattern
-- (migrations/README.md §"Expand/contract pattern").
--
-- PR 2 of the rollout will:
--   * backfill `raw_score = baseline_score` and `selector_tags = '{}'` for
--     any pre-existing rows,
--   * `ALTER COLUMN raw_score SET NOT NULL`,
--   * bump `baseline_version` to `phase1b-four-selector` so the read path
--     reads `raw_score` directly (rfc 0001 §9, §10).
--
-- Why this split is load-bearing:
--   * `SET NOT NULL` is unsafe under rolling deploys unless every running
--     replica has already started populating the new column. The Phase 1.A
--     dual-write wired in this same PR (src/lib/triage/baseline/pager.ts)
--     guarantees that.

ALTER TABLE baseline_triaged_event
    ALTER COLUMN selector_tags SET DEFAULT '{}';

ALTER TABLE baseline_triaged_event
    ADD COLUMN IF NOT EXISTS raw_score DOUBLE PRECISION;
