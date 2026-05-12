-- Story schema (1B-Story-1 / discussion #447 §3.4, §3.5, §6, §7).
--
-- Adds a new corpus layer on top of corpus A: a Story is a small
-- bundle of correlated `baseline_triaged_event` rows produced by the
-- cadence's step (f) heuristic correlator (see
-- `src/lib/triage/story/`). The user-facing label is "Story"; the
-- internal/DB names are `event_group` (container) and
-- `event_group_member` (rows).
--
-- The Story-side aggregate `score` is computed by the correlator as a
-- per-rule count or weighted count over `selector_tags` matches — it is
-- NOT a function of `raw_score`. Story rules also predicate on
-- `selector_tags` membership, never on `baseline_score`: the latter
-- does not exist on the row at cadence time (it is read-time-computed
-- via `cume_dist()` per `(kind, baseline_version)` cohort), and
-- `raw_score`'s absolute scale shifts across `baseline_version`
-- bumps. `selector_tags` is RFC 0001 §9's stable, enumerated emission
-- and survives §9 retunes; the Story RFC explicitly versions its
-- consumed tag list under `story_version` so any RFC 0001 rename or
-- addition is caught at Story-RFC review time.

CREATE TABLE IF NOT EXISTS event_group (
    id                  BIGSERIAL PRIMARY KEY,
    -- customer_id is implicit (this is a tenant DB).
    kind                TEXT NOT NULL CHECK (kind IN ('auto_correlated', 'analyst_curated')),
    -- Typo guard for the rule-ID column. The *active* rule-ID
    -- whitelist is enforced by the correlator module's enum, not by
    -- this CHECK, so RFC bumps that add R4/R5/... do not require a
    -- schema migration. v1 emits 'R1' and 'R3'; 'R2' is reserved by
    -- the Story RFC v1 for the v2 RFC bump.
    correlation_rule_id TEXT
        CHECK (correlation_rule_id IS NULL OR correlation_rule_id ~ '^R[0-9]+$'),
    story_version       TEXT NOT NULL,
    time_window_start   TIMESTAMPTZ NOT NULL,
    time_window_end     TIMESTAMPTZ NOT NULL,
    primary_asset       INET,
    score               DOUBLE PRECISION,
    summary_payload     JSONB NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- β-style submission tracking. This issue owns the columns; the
    -- Phase 2 send-to-aimer action (Y2, #493) is the writer. Until
    -- Y2 ships these stay at NULL / 0.
    --
    -- NOTE: `last_sent_by` references `accounts.id` in the **auth DB**,
    -- not this tenant DB. Integrity is app-level — account deletion
    -- produces an orphan reference rather than a constraint error.
    last_sent_at        TIMESTAMPTZ,
    last_sent_by        UUID,
    send_count          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS event_group_member (
    event_group_id BIGINT NOT NULL REFERENCES event_group(id) ON DELETE CASCADE,
    -- Semantically references `baseline_triaged_event.event_key` but
    -- NOT declared as a FK. Same reasoning as the
    -- baseline_triaged_event ↔ observed_event_meta decoupling
    -- (#456): retention windows differ (corpus A is 180d, Story
    -- retention is owned by 1B-7 / #461). A FK with `ON DELETE`
    -- would couple the windows.
    event_key      NUMERIC(39, 0) NOT NULL,
    role           TEXT NOT NULL CHECK (role IN ('primary', 'context')),
    PRIMARY KEY (event_group_id, event_key)
);

CREATE INDEX IF NOT EXISTS event_group_time_window_end_idx
    ON event_group (time_window_end DESC);
CREATE INDEX IF NOT EXISTS event_group_primary_asset_idx
    ON event_group (primary_asset);
CREATE INDEX IF NOT EXISTS event_group_unsent_score_idx
    ON event_group (score DESC) WHERE last_sent_at IS NULL;
CREATE INDEX IF NOT EXISTS event_group_member_event_key_idx
    ON event_group_member (event_key);

-- Idempotency for re-evaluated slop-window candidates: an
-- auto-correlated Story is uniquely identified by
-- (rule, asset, window). Step (f) on the next tick uses
-- ON CONFLICT DO NOTHING against this index to avoid duplicate
-- inserts when the same window is re-scanned. Analyst-curated rows
-- are intentionally excluded (curated saves can legitimately repeat
-- a window if the analyst chooses).
--
-- `primary_asset IS NOT NULL` is required because PostgreSQL treats
-- NULL as distinct in unique indexes (two rows with NULL asset would
-- both insert, defeating dedup). v1 rules R1/R3 are orig_addr-keyed
-- and explicitly skip events with NULL orig_addr at the predicate
-- level, so an auto-correlated Story with NULL primary_asset is
-- unreachable in v1; the WHERE clause guards against future-rule
-- regressions.
CREATE UNIQUE INDEX IF NOT EXISTS event_group_auto_dedup_idx
    ON event_group
    (correlation_rule_id, primary_asset, time_window_start, time_window_end)
    WHERE kind = 'auto_correlated' AND primary_asset IS NOT NULL;

-- Story slop-window watermark on the existing corpus-state
-- singleton. Required because step (f)'s next-tick replay must know
-- "everything strictly earlier than X has been considered for
-- finalization" — neither `last_event_cursor` (raw-page boundary,
-- not event_time) nor `last_ingested_at` (wall-clock, not event_time)
-- is that marker.
ALTER TABLE baseline_corpus_state
    ADD COLUMN IF NOT EXISTS story_finalized_through TIMESTAMPTZ;
