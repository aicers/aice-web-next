-- Phase 1 (#588): Triage menu engagement-signal capture.
--
-- Two tables live in each tenant DB so the signals share the same
-- physical scope as the corpus they describe (`baseline_triaged_event`,
-- `triage_exclusion`, Story / event_group_member). Cross-tenant joins
-- are never required and the tenant DB is the only place where the
-- engagement_action.event_key / engagement_impression.event_key
-- foreign-key target (`baseline_triaged_event`) is actually
-- resolvable.
--
-- Why two tables (not one).
--
-- Impression rows are a per-menu-load batch (≤ TRIAGE_HARD_EVENT_CAP =
-- 5,000 plus ≤ STORY_PROTECTED_HARD_CAP = 2,000) — they dominate
-- volume but live exclusively at the `(menu_load_id, event_key)`
-- grain. Action rows are sparse (per-click) and mix row-bound and
-- non-row-bound shapes (asset_select / pivot_click / story_pivot_click
-- / exclusion_create / strictness_change). Co-locating them in a
-- single table would force every row-bound action to carry the
-- impression-batch columns it does not own, and every impression to
-- carry the per-action-type columns it does not own. The two-table
-- shape keeps each row dense and lets the impression-batch idempotency
-- constraint (UNIQUE (menu_load_id, event_key)) live on its own table.
--
-- HMAC contract (referenced from the action / impression rows).
--
--   Key source.  `ENGAGEMENT_HMAC_KEY` env var read at process start
--   (`src/lib/triage/engagement/hmac.ts`). Global (not per-tenant)
--   because the engagement store is analytics, and per-tenant keys
--   would foreclose cross-tenant aggregate analysis Phase 2 may need.
--   The value is base64 of ≥32 random bytes; the migration does not
--   enforce a length floor — the helper does at runtime.
--
--   Normalization.  Applied BEFORE HMAC by helper functions, never
--   by the caller. Defined per dimension:
--     - IP/IPv6 (orig_addr, pivot ip dimensions): lowercase, IPv6
--       compressed form via Node's `net.isIP` + `URL`-equivalent
--       canonicalization; IPv4 → strip leading zeros per octet.
--     - Domain (host, dns_query, sni): punycode (URL hostname rule),
--       lowercased, trailing dot stripped.
--     - JA3 / JA3S / HASSH / TLS fingerprint: lowercased hex.
--     - Country: ISO-3166 alpha-2 uppercased.
--     - Asset address: same path as IP.
--     - `account_id`: trim + lowercase (account ids are case-stable
--       strings in this codebase; the normalization is defensive).
--
--   Rotation.  Non-rotating. Engagement signals are long-lived
--   analytics and a rotation would invalidate every historical row's
--   join key. The decision is captured in
--   `src/lib/triage/engagement/hmac.ts` alongside the key reader; a
--   future rotation must land an `engagement_hmac_key_version` column
--   in expand/contract.
--
-- Retention.
--
--   90 days for impressions, 180 days for actions. Bounded retention
--   protects long-lived analytics from unbounded growth; the longer
--   action floor reflects the higher value per row and the lower
--   volume. Sweep is invoked from the same cron infrastructure as the
--   exclusion snapshot retention sweep (#472) and lives in
--   `src/lib/triage/engagement/retention.ts`.
--
-- Acceptance / privacy contract (#588).
--
--   - No raw event payload. event_key is the only foreign-key into
--     `baseline_triaged_event`; raw pivot / asset values are never
--     stored — only the HMAC.
--   - `account_id` is stored as HMAC (`account_id_hmac`) per the long-
--     lived-analytics privacy contract.
--   - Impression dedup is enforced at the schema level via
--     UNIQUE (menu_load_id, event_key); replay of the same menu load
--     is a no-op.
--   - Server-side ingest failures land on the structured log channel
--     (`console.error("[engagement] …")`) plus a 4xx response — the
--     client invokes the endpoint as fire-and-forget so the operator
--     never sees a 5xx propagated into the menu UI. No dedicated
--     dead-letter table; the structured log channel is the chosen
--     drop mechanism for Phase 1.

CREATE TABLE IF NOT EXISTS engagement_impression (
    -- Per-menu-load UUID generated client-side and propagated through
    -- the impression batch. The `(menu_load_id, event_key)` UNIQUE
    -- constraint enforces idempotent replay: a duplicate POST of the
    -- same menu load is a no-op.
    menu_load_id        UUID         NOT NULL,
    -- Event identity. References `baseline_triaged_event.event_key`
    -- in the same tenant DB but kept as TEXT (no FK) so engagement
    -- rows outlive their corpus rows past the cadence retention
    -- window. Phase 2 reads tolerate orphan event_keys.
    event_key           TEXT         NOT NULL,
    -- `(kind, slot_bucket)` reproduce the per-row classification used
    -- by `composeMenu`. `slot_bucket` is `${kind}:${is_unlabeled}` —
    -- the same key {@link bucketKey} emits — so downstream slot-share
    -- analyses do not need to re-derive it from `selector_tags`.
    kind                TEXT         NOT NULL,
    slot_bucket         TEXT         NOT NULL,
    -- 1-based rank within the merged, capped union (the menu's
    -- visible position). The pivot menu uses 1-based UI ordering, so
    -- the impression rank is stored 1-based to match.
    rank                INTEGER      NOT NULL CHECK (rank >= 1),
    -- "baseline" today; widens when Policies mode (#447) shares this
    -- table.
    surface             TEXT         NOT NULL,
    -- The `baseline_version` tag in effect when the row was projected
    -- (column added to the menu-cohort projection by this issue so
    -- the impression can record it without a second read).
    baseline_version    TEXT         NOT NULL,
    -- Effective period (the analyst's chosen window). Kept on the row
    -- so a single SELECT can filter by period without joining back.
    period_start_ts     TIMESTAMPTZ  NOT NULL,
    period_end_ts       TIMESTAMPTZ  NOT NULL,
    -- Reason the row was surfaced. Three values:
    --   - `quota`           — branch A composeMenu output under the
    --                          per-bucket quota.
    --   - `fallback`        — branch A composeMenu fallback path
    --                          (when `assembledCount` was below the
    --                          MIN_NONZERO_FLOOR).
    --   - `story_protected` — branch B (Story-protected force-union).
    -- `strictness` is intentionally NOT a `shown_by` value — strictness
    -- is the menu-wide filter state, recorded separately on
    -- `strictness_stop` below.
    shown_by            TEXT         NOT NULL
        CHECK (shown_by IN ('quota', 'fallback', 'story_protected')),
    -- Slider stop in effect for this menu load. Phase 2 reads slice
    -- impressions by `strictness_stop` to separate dial-up from
    -- dial-down attention.
    strictness_stop     TEXT         NOT NULL,
    -- Per-row tenant attribution. Redundant with the DB the row lives
    -- in but explicit for cross-row analytics and consistent with the
    -- existing snapshot tables.
    customer_id         INTEGER      NOT NULL,
    -- HMAC of the actor's account_id per the privacy contract. Never
    -- raw, even though `audit_log.actor` does store it raw — audit
    -- logs are short-lived operational data while engagement signals
    -- are long-lived analytics.
    account_id_hmac     TEXT         NOT NULL,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (menu_load_id, event_key)
);

-- Period / created_at index for the retention sweep and for Phase 2
-- reads that slice impressions by window. `created_at` carries the
-- retention edge; `period_start_ts` carries the analyst's window so
-- both are indexed.
CREATE INDEX IF NOT EXISTS engagement_impression_created_at_idx
    ON engagement_impression (created_at);
CREATE INDEX IF NOT EXISTS engagement_impression_kind_bucket_idx
    ON engagement_impression (kind, slot_bucket);

CREATE TABLE IF NOT EXISTS engagement_action (
    id                  BIGSERIAL    PRIMARY KEY,
    -- `asset_select` / `pivot_click` / `story_pivot_click` /
    -- `exclusion_create` / `strictness_change`. CHECK constraint
    -- enumerates the taxonomy at the schema level — adding a new
    -- action type requires an expand migration.
    action_type         TEXT         NOT NULL
        CHECK (action_type IN (
            'asset_select',
            'pivot_click',
            'story_pivot_click',
            'exclusion_create',
            'strictness_change'
        )),
    -- Common fields. `event_key`, `kind`, `baseline_version` are
    -- nullable: row-bound actions (`pivot_click`, `story_pivot_click`)
    -- populate them; non-row-bound actions
    -- (`asset_select`, `exclusion_create`, `strictness_change`) leave
    -- them NULL. The check enforces the contract.
    event_key           TEXT,
    kind                TEXT,
    baseline_version    TEXT,
    customer_id         INTEGER      NOT NULL,
    account_id_hmac     TEXT         NOT NULL,
    surface             TEXT         NOT NULL,
    -- Per-action fields. Each is populated only for the action_type
    -- that owns it (CHECK at the bottom enforces shape).
    --
    -- `asset_select`.
    asset_key_hmac      TEXT,
    -- `pivot_click` / `story_pivot_click`.
    dimension           TEXT,
    -- Natural join key for dimensions where the pivot value is itself
    -- a server id (e.g. story_id for `story_pivot_click`'s origin
    -- already lives in `story_id`, but other pivots may carry e.g. a
    -- network id). NULL when the dimension's value is raw-ish (IP,
    -- domain, JA3, SNI, country) — `pivot_value_hmac` carries the
    -- pseudonymized form in that case.
    pivot_value_join_id TEXT,
    pivot_value_hmac    TEXT,
    -- `story_pivot_click`. Origin Story id (separate from the pivot
    -- value itself).
    story_id            TEXT,
    -- `exclusion_create`. References the `triage_exclusion.id` row
    -- this action created (the join key, not the predicate value).
    exclusion_id        TEXT,
    -- `strictness_change`. From/to stop name (string id from
    -- `STRICTNESS_STOPS`).
    strictness_from     TEXT,
    strictness_to       TEXT,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    -- Per-action shape contract. Enforces, per action_type:
    --   * Required fields are present.
    --   * Fields owned by other action types are absent (NULL).
    --   * For the two pivot row-bound types, exactly one of
    --     `pivot_value_join_id` / `pivot_value_hmac` is populated —
    --     the parser routes natural-join dimensions into
    --     `pivot_value_join_id` and raw-ish dimensions through HMAC
    --     into `pivot_value_hmac`, and the schema reproduces that
    --     XOR so a buggy producer cannot land a half-populated pivot
    --     row.
    --
    -- The tenant-side store is the durable contract Phase 2 reads
    -- from. The HTTP parser and storage code shape rows correctly
    -- today, but enforcing the shape at the schema makes the store
    -- self-defending against future producers (e.g. a backfill, a
    -- replay tool, a different surface that learns to write here).
    CONSTRAINT engagement_action_shape CHECK (
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
            ELSE FALSE
        END
    )
);

CREATE INDEX IF NOT EXISTS engagement_action_created_at_idx
    ON engagement_action (created_at);
CREATE INDEX IF NOT EXISTS engagement_action_type_created_at_idx
    ON engagement_action (action_type, created_at);
CREATE INDEX IF NOT EXISTS engagement_action_event_key_idx
    ON engagement_action (event_key)
    WHERE event_key IS NOT NULL;
