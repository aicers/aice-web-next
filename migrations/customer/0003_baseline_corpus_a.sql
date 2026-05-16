-- Triage baseline corpus A schema (1B-1 / discussion #447 §3.4).
--
-- Three tables in every customer-tenant DB. The cadence runner
-- (src/lib/triage/baseline/cadence.ts) fills them once every 15
-- minutes per customer; the menu reads `baseline_triaged_event` (1B-3)
-- and the window-aggregate signals read `observed_event_meta` (1B-8).
-- The
-- corpus is filled with the unbiased standard-filter survivor stream,
-- with per-customer + global exclusions re-applied app-side at cadence
-- time so cadence-time and retroactive-DELETE paths target the same
-- normalized columns.
--
-- `event_key` is review's RocksDB primary key (i128). Numeric(39,0) is
-- the smallest exact-decimal type that holds an unsigned 128-bit value
-- (max 2^128 = 340 282 366 920 938 463 463 374 607 431 768 211 456,
-- 39 digits). This is the single source of truth for event identity:
-- joins between the two corpus tables happen on `event_key`, and PK
-- collisions on re-ingest are handled by the cadence runner with
-- ON CONFLICT DO NOTHING.

CREATE TABLE IF NOT EXISTS baseline_triaged_event (
    event_key          NUMERIC(39, 0) PRIMARY KEY,
    event_time         TIMESTAMPTZ    NOT NULL,
    kind               TEXT           NOT NULL,
    sensor             TEXT           NOT NULL,
    orig_addr          INET,
    orig_port          INTEGER,
    resp_addr          INET,
    resp_port          INTEGER,
    proto              INTEGER,
    -- Normalized exclusion-matching columns. HTTP/TLS variants populate
    -- `host`; DNS variants populate `dns_query`; HTTP variants populate
    -- `uri`; NTLM variants populate `host` from `hostname`. Extracted
    -- at INSERT time so retroactive exclusion ADD (#457) can DELETE
    -- matching rows by index without scanning JSONB payloads.
    host               TEXT,
    dns_query          TEXT,
    uri                TEXT,
    ingested_at        TIMESTAMPTZ    NOT NULL DEFAULT now(),
    baseline_version   TEXT           NOT NULL,
    exclusions_fp      TEXT           NOT NULL,
    category           TEXT,
    baseline_score     DOUBLE PRECISION,
    selector_tags      TEXT[],
    payload_summary    JSONB
);

-- IpAddress exclusion uses CIDR containment (<<, <<=) which a btree on
-- `inet` does NOT index efficiently; use GiST with inet_ops for those
-- lookups. Other indexes are plain btree (equality / range).
CREATE INDEX IF NOT EXISTS baseline_triaged_event_orig_addr_gist
    ON baseline_triaged_event USING gist (orig_addr inet_ops);
CREATE INDEX IF NOT EXISTS baseline_triaged_event_resp_addr_gist
    ON baseline_triaged_event USING gist (resp_addr inet_ops);
CREATE INDEX IF NOT EXISTS baseline_triaged_event_event_time_idx
    ON baseline_triaged_event (event_time DESC);
CREATE INDEX IF NOT EXISTS baseline_triaged_event_sensor_event_time_idx
    ON baseline_triaged_event (sensor, event_time DESC);
-- Composite index originally intended to serve the menu's "time window +
-- score threshold" filter pattern. In practice `baseline_score` is NULL
-- on every Phase 1.B row (the column is read-time-only — see
-- `src/lib/triage/baseline/pager.ts` and §3 of the Baseline RFC), so the
-- second column is all-NULL and the index degenerates to an `event_time`
-- btree that the existing `baseline_triaged_event_event_time_idx` already
-- covers. The #471 strictness slider does NOT use it: its cutoff
-- compares against the SELECT-time `cume_dist()` projection over
-- `raw_score`, not the stored column. Dropped in migration
-- `0013_drop_degenerate_baseline_score_idx.sql`; kept here for
-- historical context. Fresh deployments will still CREATE the index
-- on this migration and the 0013 migration will DROP it immediately
-- after — the temporary cost is acceptable on first-time setup.
CREATE INDEX IF NOT EXISTS baseline_triaged_event_event_time_score_idx
    ON baseline_triaged_event (event_time DESC, baseline_score DESC);
CREATE INDEX IF NOT EXISTS baseline_triaged_event_host_idx
    ON baseline_triaged_event (host);
CREATE INDEX IF NOT EXISTS baseline_triaged_event_dns_query_idx
    ON baseline_triaged_event (dns_query);
CREATE INDEX IF NOT EXISTS baseline_triaged_event_uri_idx
    ON baseline_triaged_event (uri);

CREATE TABLE IF NOT EXISTS baseline_corpus_state (
    -- Singleton enforced by a constant primary key.
    id                 BOOLEAN     PRIMARY KEY DEFAULT true CHECK (id),
    last_ingested_at   TIMESTAMPTZ,
    last_event_cursor  TEXT,
    baseline_version   TEXT,
    exclusions_fp      TEXT,
    last_run_status    TEXT        CHECK (last_run_status IN ('ok', 'failed', 'running')),
    last_error         TEXT
);

CREATE TABLE IF NOT EXISTS observed_event_meta (
    -- Captures every event surviving the cadence's exclusion re-application
    -- regardless of baseline outcome. Unbiased input for window-aggregate
    -- signals (1B-8); using `baseline_triaged_event` would create selection
    -- bias. NOT FK-linked to baseline_triaged_event because retention windows
    -- differ (180d vs 30d); same-transaction INSERT order is the consistency
    -- guarantee.
    event_key   NUMERIC(39, 0) PRIMARY KEY,
    event_time  TIMESTAMPTZ    NOT NULL,
    kind        TEXT           NOT NULL,
    category    TEXT,
    sensor      TEXT           NOT NULL,
    orig_addr   INET,
    resp_addr   INET,
    host        TEXT,
    dns_query   TEXT,
    uri         TEXT,
    confidence  REAL
);
CREATE INDEX IF NOT EXISTS observed_event_meta_orig_addr_gist
    ON observed_event_meta USING gist (orig_addr inet_ops);
CREATE INDEX IF NOT EXISTS observed_event_meta_resp_addr_gist
    ON observed_event_meta USING gist (resp_addr inet_ops);
CREATE INDEX IF NOT EXISTS observed_event_meta_event_time_idx
    ON observed_event_meta (event_time DESC);
CREATE INDEX IF NOT EXISTS observed_event_meta_kind_event_time_idx
    ON observed_event_meta (kind, event_time DESC);
CREATE INDEX IF NOT EXISTS observed_event_meta_host_idx
    ON observed_event_meta (host);
CREATE INDEX IF NOT EXISTS observed_event_meta_dns_query_idx
    ON observed_event_meta (dns_query);
CREATE INDEX IF NOT EXISTS observed_event_meta_uri_idx
    ON observed_event_meta (uri);
