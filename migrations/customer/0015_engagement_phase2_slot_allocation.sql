-- Phase 2 (#589): Engagement-driven slot allocation substrate.
--
-- Expand-only migration. Three independent changes, all serving the
-- Phase 2 RFC (#593 / RFC 0003) substrate without altering Phase 1
-- (#588) captured rows:
--
--   1. New `engagement_model_snapshot` table (RFC §8.2). One row per
--      `engagement_model_version`; immutable audit record of the
--      formula coefficients and aggregate-SQL digest in effect when an
--      impression was projected.
--
--   2. `engagement_impression.engagement_model_version` column (RFC
--      §8.3). NULLABLE: rows captured by Phase 1 (#588) between its
--      deploy and Phase 2's expand have no engagement model associated
--      with their menu placement, and a sentinel backfill would
--      falsify the audit record. From #589's deploy forward, every new
--      impression carries the active `engagement_model_version`.
--
--   3. `engagement_action.menu_load_id` column (RFC §2.2). Self-
--      defending strict CHECK + `legacy_pre_menu_load_id` flag + a
--      cutover timestamp predicate so a buggy producer cannot write a
--      new `pivot_click` / `story_pivot_click` with NULL
--      `menu_load_id` regardless of what the flag is set to. The
--      cutover predicate (literal NOW() captured at migration write
--      time) is what makes the legacy branch reachable only by pre-
--      expand rows; the flag remains useful as self-documentation and
--      for audit queries.
--
-- Phase 2a ships with `γ = 0` so menu output is byte-identical to RFC
-- 0001. `baseline_version` is NOT bumped here per the amended RFC §13;
-- the bump moves to Phase 2b alongside the calibrated `γ > 0` that
-- actually changes menu output.

CREATE TABLE IF NOT EXISTS engagement_model_snapshot (
    -- The `engagement_model_version` tag (RFC §8.1) at the time the
    -- snapshot was captured. PK so a single row per version exists in
    -- the tenant DB; `ON CONFLICT DO NOTHING` semantics on insert.
    version               TEXT         PRIMARY KEY,
    -- Coefficients + guardrail params (RFC §9.3). JSONB so future
    -- guardrails can be added without an expand migration on the
    -- snapshot table itself.
    formula               JSONB        NOT NULL,
    -- {active_windows, selection_rule, half_life_window_ratio}
    -- materialised so a future investigator can reconstruct the
    -- window selection without re-reading the code that wrote it.
    window_bounds         JSONB        NOT NULL,
    -- SHA-256 of the parametrized §7 aggregate SQL template. Captures
    -- the per-load query template — not a per-load filled query —
    -- because the template is what changes when the formula changes.
    aggregate_sql_digest  TEXT         NOT NULL,
    -- First-observed timestamp. ON CONFLICT (version) DO NOTHING means
    -- a re-deploy of the same version does not refresh this column.
    captured_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE engagement_impression
    ADD COLUMN IF NOT EXISTS engagement_model_version TEXT;

-- Composite index supporting the §7 aggregate's per-bucket scan over
-- the (window, shown_by, strictness_stop) filter. The existing
-- `engagement_impression_kind_bucket_idx` covers (kind, slot_bucket)
-- but not the additional filters Phase 2 reads slice by. The added
-- index is the smallest one that covers the canonical aggregate
-- without over-indexing — created_at first so the window-bound BETWEEN
-- prunes early, then the two filter columns, then slot_bucket for the
-- GROUP BY.
CREATE INDEX IF NOT EXISTS engagement_impression_phase2_aggregate_idx
    ON engagement_impression (created_at, shown_by, strictness_stop, slot_bucket);

ALTER TABLE engagement_action
    ADD COLUMN IF NOT EXISTS menu_load_id UUID;
ALTER TABLE engagement_action
    ADD COLUMN IF NOT EXISTS legacy_pre_menu_load_id BOOLEAN NOT NULL DEFAULT FALSE;

-- Mark only pre-expand row-bound actions as legacy. Non-row-bound
-- types never had / never will have menu_load_id; the flag is
-- meaningless for them and stays FALSE so they continue to satisfy
-- the new CHECK below.
UPDATE engagement_action
    SET legacy_pre_menu_load_id = TRUE
    WHERE action_type IN ('pivot_click', 'story_pivot_click');

-- Strict CHECK contract per RFC §2.2 option (b).
--
-- Row-bound action types (`pivot_click`, `story_pivot_click`) require
-- `menu_load_id IS NOT NULL` for any new row, EXCEPT for pre-expand
-- legacy rows whose `created_at` predates the cutover timestamp
-- captured below. Non-row-bound types (`asset_select`,
-- `exclusion_create`, `strictness_change`) require
-- `menu_load_id IS NULL` so the column's presence/absence is part of
-- each action_type's shape.
--
-- The cutover predicate `created_at < '<phase2_expand_cutover>'` is
-- what enforces "the legacy branch is reachable only by pre-expand
-- rows" — a producer cannot bypass `menu_load_id IS NOT NULL` simply
-- by setting `legacy_pre_menu_load_id = TRUE`, because the row's
-- `created_at` (DEFAULT NOW(), not caller-supplied) will fail the
-- predicate. The flag is retained for self-documentation and audit
-- queries (`SELECT COUNT(*) WHERE legacy_pre_menu_load_id`).
DO $$
DECLARE
    cutover TIMESTAMPTZ := NOW();
    cutover_literal TEXT := quote_literal(cutover::TEXT);
BEGIN
    EXECUTE 'ALTER TABLE engagement_action DROP CONSTRAINT engagement_action_shape';
    EXECUTE format($f$
        ALTER TABLE engagement_action ADD CONSTRAINT engagement_action_shape CHECK (
            CASE action_type
                WHEN 'pivot_click' THEN
                    event_key IS NOT NULL
                    AND kind IS NOT NULL
                    AND baseline_version IS NOT NULL
                    AND dimension IS NOT NULL
                    AND (
                        (pivot_value_join_id IS NOT NULL
                            AND pivot_value_hmac IS NULL)
                        OR (pivot_value_join_id IS NULL
                            AND pivot_value_hmac IS NOT NULL)
                    )
                    AND asset_key_hmac IS NULL
                    AND story_id IS NULL
                    AND exclusion_id IS NULL
                    AND strictness_from IS NULL
                    AND strictness_to IS NULL
                    AND (
                        menu_load_id IS NOT NULL
                        OR (legacy_pre_menu_load_id
                            AND created_at < TIMESTAMPTZ %1$s)
                    )
                WHEN 'story_pivot_click' THEN
                    event_key IS NOT NULL
                    AND kind IS NOT NULL
                    AND baseline_version IS NOT NULL
                    AND dimension IS NOT NULL
                    AND story_id IS NOT NULL
                    AND (
                        (pivot_value_join_id IS NOT NULL
                            AND pivot_value_hmac IS NULL)
                        OR (pivot_value_join_id IS NULL
                            AND pivot_value_hmac IS NOT NULL)
                    )
                    AND asset_key_hmac IS NULL
                    AND exclusion_id IS NULL
                    AND strictness_from IS NULL
                    AND strictness_to IS NULL
                    AND (
                        menu_load_id IS NOT NULL
                        OR (legacy_pre_menu_load_id
                            AND created_at < TIMESTAMPTZ %1$s)
                    )
                WHEN 'asset_select' THEN
                    asset_key_hmac IS NOT NULL
                    AND event_key IS NULL
                    AND kind IS NULL
                    AND baseline_version IS NULL
                    AND dimension IS NULL
                    AND pivot_value_join_id IS NULL
                    AND pivot_value_hmac IS NULL
                    AND story_id IS NULL
                    AND exclusion_id IS NULL
                    AND strictness_from IS NULL
                    AND strictness_to IS NULL
                    AND menu_load_id IS NULL
                WHEN 'exclusion_create' THEN
                    exclusion_id IS NOT NULL
                    AND event_key IS NULL
                    AND kind IS NULL
                    AND baseline_version IS NULL
                    AND asset_key_hmac IS NULL
                    AND dimension IS NULL
                    AND pivot_value_join_id IS NULL
                    AND pivot_value_hmac IS NULL
                    AND story_id IS NULL
                    AND strictness_from IS NULL
                    AND strictness_to IS NULL
                    AND menu_load_id IS NULL
                WHEN 'strictness_change' THEN
                    strictness_from IS NOT NULL
                    AND strictness_to IS NOT NULL
                    AND event_key IS NULL
                    AND kind IS NULL
                    AND baseline_version IS NULL
                    AND asset_key_hmac IS NULL
                    AND dimension IS NULL
                    AND pivot_value_join_id IS NULL
                    AND pivot_value_hmac IS NULL
                    AND story_id IS NULL
                    AND exclusion_id IS NULL
                    AND menu_load_id IS NULL
                ELSE FALSE
            END
        )
    $f$, cutover_literal);
END $$;

-- §7 numerator JOIN scans `engagement_action` on (menu_load_id,
-- event_key). The existing `engagement_action_event_key_idx` covers
-- the second half of the JOIN predicate; a partial index on
-- menu_load_id (defined only where it is populated) covers the first
-- half without bloating the action table's footprint with NULL rows.
CREATE INDEX IF NOT EXISTS engagement_action_menu_load_id_idx
    ON engagement_action (menu_load_id, event_key)
    WHERE menu_load_id IS NOT NULL;
