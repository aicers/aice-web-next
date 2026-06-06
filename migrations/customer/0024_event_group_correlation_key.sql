-- Multi-source Story correlation rules R4 (fan-in) / R5 (campaign)
-- (Story RFC §3, §5; issue #694).
--
-- v1 auto-correlation (R1, R3) keys every Story on a single source
-- asset (`primary_asset = orig_addr`), so its dedup index
-- (`event_group_auto_dedup_idx`, migration 0008) keys on
-- `(correlation_rule_id, primary_asset, time_window_start,
-- time_window_end) WHERE primary_asset IS NOT NULL`. The new rules
-- break that assumption:
--
--   * R5 (campaign) has `primary_asset = NULL` — the old index's
--     `primary_asset IS NOT NULL` predicate excludes it, so it cannot
--     be deduped there.
--   * R4 (fan-in) sets `primary_asset = resp_addr`, and two R4 rows
--     on the same victim + window that differ only by `category`
--     would collide on `(rule, asset, window)` even though they are
--     legitimately distinct Stories.
--
-- The fix is a separate `correlation_key` discriminator with its own
-- index, plus a re-scope of the old index so each governs a disjoint
-- partition: R1/R3 (`correlation_key IS NULL`) on the old index,
-- R4/R5 (`correlation_key IS NOT NULL`) on the new one. This keeps
-- `ON CONFLICT` arbitration unambiguous (it only arbitrates the named
-- index) — an R4 row that falls under both predicates would otherwise
-- raise an unhandled `unique_violation` on the un-named old index.
--
-- This migration is NOT purely additive: it re-scopes one existing
-- index (DROP + CREATE, no data change). R1/R3 dedup semantics are
-- preserved — their rows keep `correlation_key = NULL` and continue
-- to dedup on the (now NULL-correlation_key-scoped) old index.

ALTER TABLE event_group
    ADD COLUMN IF NOT EXISTS correlation_key TEXT;

-- New dedup index governing the multi-source rules. R4 sets
-- `correlation_key = host(resp_addr) || '|' || category`; R5 sets
-- `correlation_key = category`. The `correlation_key IS NOT NULL`
-- predicate keeps R1/R3 out of this index.
CREATE UNIQUE INDEX IF NOT EXISTS event_group_corrkey_dedup_idx
    ON event_group
    (correlation_rule_id, correlation_key, time_window_start, time_window_end)
    WHERE kind = 'auto_correlated' AND correlation_key IS NOT NULL;

-- Re-scope the existing index so `correlation_key`-bearing rows leave
-- its scope. Without the added `AND correlation_key IS NULL`, an R4
-- row (which sets BOTH `primary_asset` and `correlation_key`) would
-- fall under this index too, and a second same-victim/same-window R4
-- row differing only by `category` would raise an unhandled
-- `unique_violation` here (ON CONFLICT only arbitrates the named
-- `correlation_key` index). R1/R3 dedup semantics are unchanged — they
-- always carry `correlation_key IS NULL`.
DROP INDEX IF EXISTS event_group_auto_dedup_idx;
CREATE UNIQUE INDEX event_group_auto_dedup_idx
    ON event_group
    (correlation_rule_id, primary_asset, time_window_start, time_window_end)
    WHERE kind = 'auto_correlated' AND primary_asset IS NOT NULL
      AND correlation_key IS NULL;
