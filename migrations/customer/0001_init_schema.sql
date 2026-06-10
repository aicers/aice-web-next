-- Customer (tenant) DB v1 initial schema.
--
-- The pre-release migration history (0001-0025) was squashed into this
-- single file before the first release; it creates the complete tenant
-- schema and seed data on an empty database. Every table lives in the
-- per-customer tenant DB, so no table carries a `customer_id` scope
-- column — the database itself is the customer scope. Columns that
-- reference `auth_db` rows (account ids, etc.) are plain UUIDs with no
-- FK because PostgreSQL does not support cross-database foreign keys;
-- existence is enforced at the application layer.

-- ── Triage policies (corpus B input) ───────────────────────────────

-- Triage policy CRUD storage (1B-5 / discussion #447 §2.1).
--
-- Rule lists are stored as JSONB; their structural validation is done
-- at the application layer (see src/lib/triage/policy/validation.ts).
--
-- `id` is INTEGER (not BIGINT) so node-postgres returns it as a JS
-- number rather than a string — matches the `TriagePolicyRow.id:
-- number` contract in src/lib/triage/policy/types.ts and lines up
-- with the GraphQL `Int` path described in #447 §2.1 for the
-- inline-policy id surface.
CREATE TABLE triage_policy (
  id           SERIAL PRIMARY KEY,
  name         TEXT        NOT NULL,
  packet_attr  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  confidence   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  response     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX triage_policy_name_key
  ON triage_policy (name);

-- ── Baseline corpus A ──────────────────────────────────────────────

-- Triage baseline corpus A (1B-1 / discussion #447 §3.4; RFC 0001).
--
-- The cadence runner (src/lib/triage/baseline/cadence.ts) fills these
-- tables once every 15 minutes per customer; the menu reads
-- `baseline_triaged_event` (1B-3) and the window-aggregate signals
-- read `observed_event_meta` (1B-8). The corpus is filled with the
-- unbiased standard-filter survivor stream, with per-customer + global
-- exclusions re-applied app-side at cadence time so cadence-time and
-- retroactive-DELETE paths target the same normalized columns.
--
-- `event_key` is review's RocksDB primary key (i128). Numeric(39,0) is
-- the smallest exact-decimal type that holds an unsigned 128-bit value
-- (max 2^128 = 340 282 366 920 938 463 463 374 607 431 768 211 456,
-- 39 digits). This is the single source of truth for event identity:
-- joins between the two corpus tables happen on `event_key`, and PK
-- collisions on re-ingest are handled by the cadence runner with
-- ON CONFLICT DO NOTHING.
--
-- There is no stored per-event baseline score: the menu read path
-- computes it at read time as `cume_dist()` over `raw_score` per
-- `(kind, baseline_version)` cohort (RFC 0001 §3; see
-- src/lib/triage/baseline/read-path-sql.mjs). `raw_score` holds the
-- additive selector score the cadence computed at ingest.
-- `selector_tags` (RFC 0001 §9) is the stable, enumerated selector
-- emission; both columns are always supplied by the writers, so
-- neither carries a DEFAULT.
CREATE TABLE baseline_triaged_event (
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
    selector_tags      TEXT[]         NOT NULL,
    payload_summary    JSONB,
    raw_score          DOUBLE PRECISION NOT NULL
);

-- IpAddress exclusion uses CIDR containment (<<, <<=) which a btree on
-- `inet` does NOT index efficiently; use GiST with inet_ops for those
-- lookups. Other indexes are plain btree (equality / range).
CREATE INDEX baseline_triaged_event_orig_addr_gist
    ON baseline_triaged_event USING gist (orig_addr inet_ops);
CREATE INDEX baseline_triaged_event_resp_addr_gist
    ON baseline_triaged_event USING gist (resp_addr inet_ops);
CREATE INDEX baseline_triaged_event_event_time_idx
    ON baseline_triaged_event (event_time DESC);
CREATE INDEX baseline_triaged_event_sensor_event_time_idx
    ON baseline_triaged_event (sensor, event_time DESC);
CREATE INDEX baseline_triaged_event_host_idx
    ON baseline_triaged_event (host);
CREATE INDEX baseline_triaged_event_dns_query_idx
    ON baseline_triaged_event (dns_query);
CREATE INDEX baseline_triaged_event_uri_idx
    ON baseline_triaged_event (uri);

-- Per-cohort raw_score btree index (RFC 0001 §9, §11). Column order is
-- dictated by the planner's index-resolution rules:
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
CREATE INDEX baseline_triaged_event_kind_version_raw_score_event_time_idx
    ON baseline_triaged_event (kind, baseline_version, raw_score DESC, event_time DESC);

CREATE TABLE baseline_corpus_state (
    -- Singleton enforced by a constant primary key.
    id                 BOOLEAN     PRIMARY KEY DEFAULT true CHECK (id),
    last_ingested_at   TIMESTAMPTZ,
    last_event_cursor  TEXT,
    baseline_version   TEXT,
    exclusions_fp      TEXT,
    last_run_status    TEXT        CHECK (last_run_status IN ('ok', 'failed', 'running')),
    last_error         TEXT,
    -- Explicit wall-clock marker the §7 cold-start activation reads
    -- (RFC 0001). Using the corpus-state singleton (PK-indexed, O(1)
    -- lookup) rather than `min(event_time) FROM observed_event_meta`
    -- avoids the failure mode where an initial catch-up page of
    -- historical events would otherwise immediately activate
    -- 7d / 14d / 30d windows whose corpus is still partial. NULL until
    -- the cadence runner's first successful page commit sets it via
    -- `COALESCE(corpus_activated_at, NOW())`.
    corpus_activated_at TIMESTAMPTZ,
    -- Story slop-window watermark. Step (f)'s next-tick replay must
    -- know "everything strictly earlier than X has been considered for
    -- finalization" — neither `last_event_cursor` (raw-page boundary,
    -- not event_time) nor `last_ingested_at` (wall-clock, not
    -- event_time) is that marker.
    story_finalized_through TIMESTAMPTZ,
    -- Wall-clock moment of the most recent admin-driven force-rebuild
    -- (#473, `POST /api/triage/baseline/rebuild`). The cadence runner
    -- does NOT touch this column — it remains a side-channel marker
    -- exclusive to the admin rebuild path. NULL means "never rebuilt".
    last_rebuild_at    TIMESTAMPTZ,
    -- Low-and-slow Story sweep watermark (#701). The hourly sweep
    -- (src/lib/triage/baseline/lowslow-sweep.ts) mirrors the cadence
    -- step-(f) finalization protocol over a 24h window, decoupled from
    -- the 15-minute cadence, and needs its own monotonic watermark —
    -- exactly the role `story_finalized_through` plays for the cadence
    -- path. Advanced with `GREATEST(...)`, never backward — see
    -- `advanceLowslowWatermark` in src/lib/triage/story/repository.ts.
    lowslow_finalized_through TIMESTAMPTZ
);

CREATE TABLE observed_event_meta (
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
CREATE INDEX observed_event_meta_orig_addr_gist
    ON observed_event_meta USING gist (orig_addr inet_ops);
CREATE INDEX observed_event_meta_resp_addr_gist
    ON observed_event_meta USING gist (resp_addr inet_ops);
CREATE INDEX observed_event_meta_event_time_idx
    ON observed_event_meta (event_time DESC);
CREATE INDEX observed_event_meta_kind_event_time_idx
    ON observed_event_meta (kind, event_time DESC);
CREATE INDEX observed_event_meta_host_idx
    ON observed_event_meta (host);
CREATE INDEX observed_event_meta_dns_query_idx
    ON observed_event_meta (dns_query);
CREATE INDEX observed_event_meta_uri_idx
    ON observed_event_meta (uri);

-- ── Customer-scoped triage exclusions ──────────────────────────────

-- Customer-scoped triage exclusions storage (1B-2 / discussion #447
-- §3.4). Same column shape as `auth_db.global_triage_exclusion` so the
-- shared exclusion helper can union them transparently. The only
-- differences: placement (`auth_db` vs each tenant DB) and
-- `created_by` being a plain UUID with no FK (cross-database).
CREATE TABLE triage_exclusion (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind          TEXT NOT NULL CHECK (kind IN ('ipAddress', 'hostname', 'uri', 'domain')),
    value         TEXT NOT NULL,
    domain_suffix TEXT,
    note          TEXT,
    -- UUID of the account in `auth_db.accounts`. Cross-DB FKs are not
    -- supported, so existence is enforced at the application layer
    -- (same pattern as `policy_triage_run.owner_account_id`).
    created_by    UUID NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (kind, value)
);
CREATE INDEX triage_exclusion_kind_idx
    ON triage_exclusion (kind);

-- ── Stories (event groups) ─────────────────────────────────────────

-- Story schema (1B-Story-1 / discussion #447 §3.4, §3.5, §6, §7).
--
-- A Story is a small bundle of correlated `baseline_triaged_event`
-- rows produced by the cadence's step (f) heuristic correlator (see
-- `src/lib/triage/story/`). The user-facing label is "Story"; the
-- internal/DB names are `event_group` (container) and
-- `event_group_member` (rows).
--
-- The Story-side aggregate `score` is computed by the correlator as a
-- per-rule count or weighted count over `selector_tags` matches — it
-- is NOT a function of `raw_score`. Story rules also predicate on
-- `selector_tags` membership, never on the read-time baseline score
-- (which does not exist on the row at cadence time — it is computed
-- via `cume_dist()` per `(kind, baseline_version)` cohort), and
-- `raw_score`'s absolute scale shifts across `baseline_version`
-- bumps. `selector_tags` is RFC 0001 §9's stable, enumerated emission
-- and survives §9 retunes; the Story RFC explicitly versions its
-- consumed tag list under `story_version` so any RFC 0001 rename or
-- addition is caught at Story-RFC review time.
CREATE TABLE event_group (
    id                  BIGSERIAL PRIMARY KEY,
    kind                TEXT NOT NULL CHECK (kind IN ('auto_correlated', 'analyst_curated')),
    -- Typo guard for the rule-ID column. The *active* rule-ID
    -- whitelist is enforced by the correlator module's enum, not by
    -- this CHECK, so RFC bumps that add new rules do not require a
    -- schema migration.
    correlation_rule_id TEXT
        CHECK (correlation_rule_id IS NULL OR correlation_rule_id ~ '^R[0-9]+$'),
    story_version       TEXT NOT NULL,
    time_window_start   TIMESTAMPTZ NOT NULL,
    time_window_end     TIMESTAMPTZ NOT NULL,
    primary_asset       INET,
    score               DOUBLE PRECISION,
    summary_payload     JSONB NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- β-style submission tracking; the Phase 2 send-to-aimer action
    -- (Y2, #493) is the writer.
    --
    -- NOTE: `last_sent_by` references `accounts.id` in the **auth DB**,
    -- not this tenant DB. Integrity is app-level — account deletion
    -- produces an orphan reference rather than a constraint error.
    last_sent_at        TIMESTAMPTZ,
    last_sent_by        UUID,
    send_count          INTEGER NOT NULL DEFAULT 0,
    -- Dedup discriminator for multi-source correlation rules (Story
    -- RFC §3, §5; #694). Single-asset rules (R1/R3/R6) leave it NULL
    -- and dedup on `event_group_auto_dedup_idx`; multi-source rules
    -- populate it (R4: `host(resp_addr) || '|' || category`, R5:
    -- `category`) and dedup on `event_group_corrkey_dedup_idx`.
    correlation_key     TEXT
);

CREATE TABLE event_group_member (
    event_group_id BIGINT NOT NULL REFERENCES event_group(id) ON DELETE CASCADE,
    -- Semantically references `baseline_triaged_event.event_key` but
    -- NOT declared as a FK: retention windows differ (corpus A is
    -- 180d, Story retention is owned by 1B-7 / #461). A FK with
    -- `ON DELETE` would couple the windows.
    event_key      NUMERIC(39, 0) NOT NULL,
    role           TEXT NOT NULL CHECK (role IN ('primary', 'context')),
    PRIMARY KEY (event_group_id, event_key)
);

CREATE INDEX event_group_time_window_end_idx
    ON event_group (time_window_end DESC);
CREATE INDEX event_group_primary_asset_idx
    ON event_group (primary_asset);
CREATE INDEX event_group_unsent_score_idx
    ON event_group (score DESC) WHERE last_sent_at IS NULL;
CREATE INDEX event_group_member_event_key_idx
    ON event_group_member (event_key);

-- Idempotency for re-evaluated slop-window candidates. Two partial
-- unique dedup indexes govern disjoint partitions of the
-- auto-correlated rows, so `ON CONFLICT` arbitration stays unambiguous
-- (it only arbitrates the named index — see the dual-arbiter routing
-- in src/lib/triage/story/repository.ts):
--
--   * Single-asset rules (`correlation_key IS NULL`): identified by
--     (rule, asset, window). `primary_asset IS NOT NULL` is required
--     because PostgreSQL treats NULL as distinct in unique indexes
--     (two rows with NULL asset would both insert, defeating dedup);
--     the single-asset rules are orig_addr-keyed and skip events with
--     NULL orig_addr at the predicate level, so the WHERE clause
--     guards against future-rule regressions.
--   * Multi-source rules (`correlation_key IS NOT NULL`): identified
--     by (rule, correlation_key, window). R4 sets BOTH `primary_asset`
--     (= resp_addr) and `correlation_key`, so without the
--     `correlation_key IS NULL` scoping on the first index, a second
--     same-victim/same-window R4 row differing only by `category`
--     would raise an unhandled `unique_violation` there.
--
-- Analyst-curated rows are intentionally excluded from both (curated
-- saves can legitimately repeat a window if the analyst chooses).
CREATE UNIQUE INDEX event_group_auto_dedup_idx
    ON event_group
    (correlation_rule_id, primary_asset, time_window_start, time_window_end)
    WHERE kind = 'auto_correlated' AND primary_asset IS NOT NULL
      AND correlation_key IS NULL;
CREATE UNIQUE INDEX event_group_corrkey_dedup_idx
    ON event_group
    (correlation_rule_id, correlation_key, time_window_start, time_window_end)
    WHERE kind = 'auto_correlated' AND correlation_key IS NOT NULL;

-- The Phase 2 story drain (`POST /api/aimer/phase2/story/next-batch`)
-- selects the next slice of unsent auto-correlated Stories using a
-- `(created_at, id)` cursor — not `(time_window_end, id)`. Cursor by
-- `created_at` (monotonic at insert) closes the late-insert race in
-- which a Story inserted after a slice was loaded but with a
-- `time_window_end` that sorts inside the just-minted range would
-- otherwise live permanently behind the advanced cursor and never be
-- delivered. See `src/lib/aimer/phase2/story-push.ts`.
CREATE INDEX event_group_auto_created_at_idx
    ON event_group (created_at, id)
    WHERE kind = 'auto_correlated';

-- Straggler-scan support for the same drain
-- (`loadStoryStragglerSlice`): a `(created_at, id)` range scan
-- restricted to rows that have NOT been delivered yet. Once a Story's
-- β columns are bumped on ack (`last_sent_at` is set), it drops out of
-- this partial index and is never re-considered. The narrower partial
-- predicate vs `event_group_auto_created_at_idx` keeps the straggler
-- scan O(unsent rows in window) rather than O(all auto rows in
-- window).
CREATE INDEX event_group_auto_unsent_created_at_idx
    ON event_group (created_at, id)
    WHERE kind = 'auto_correlated' AND last_sent_at IS NULL;

-- ── Policy triage runs (corpus B) ──────────────────────────────────

-- Triage policy corpus B (1B-6 / discussion #447 §3.4-3.5).
--
-- The corpus B runner (src/lib/triage/policy/corpus-b/) creates one
-- `policy_triage_run` per user-triggered "With my policies" request
-- and fills `policy_triaged_event` with the per-event triage outcome
-- for that run. Each run's identity is the tuple
-- `(owner_account_id, period_start, period_end,
--   policies_fingerprint, exclusions_fingerprint, baseline_version)`;
-- the partial unique index on `(status IN ('computing', 'ready'))`
-- enforces "one active run per fingerprint" while letting
-- `failed` / `superseded` rows accumulate for diagnostics.
CREATE TABLE policy_triage_run (
    -- BIGSERIAL so the recompute transaction can pre-allocate `new_id`
    -- before the supersede-then-INSERT pair commits.
    id                      BIGSERIAL PRIMARY KEY,

    -- Account that triggered the run. References
    -- `auth_db.accounts(id)`; cross-DB FK is not supported, so the
    -- application layer enforces existence.
    owner_account_id        UUID NOT NULL,

    -- Selection window. `period_end - period_start` is bounded by the
    -- 30-day menu cap (#447 §3.2); enforcement lives in the
    -- application layer because it is a product rule, not a schema
    -- invariant.
    period_start            TIMESTAMPTZ NOT NULL,
    period_end              TIMESTAMPTZ NOT NULL,

    -- Active-fingerprint columns. `policies_fingerprint` is a
    -- canonicalized hash of the inline policy set, computed by
    -- `computePoliciesFingerprint` (see
    -- src/lib/triage/policy/corpus-b/fingerprint.ts).
    -- `exclusions_fingerprint` is the same canonical hash the cadence
    -- runner writes to `baseline_corpus_state.exclusions_fp` so a
    -- subsequent exclusion change reliably changes the active slot.
    -- `baseline_version` ties the run to the deterministic baseline
    -- algorithm version that produced it (#447 §3.6 / 1B-8).
    policies_fingerprint    TEXT NOT NULL,
    exclusions_fingerprint  TEXT NOT NULL,
    baseline_version        TEXT NOT NULL,

    -- Run lifecycle. `computing` and `ready` occupy the active slot
    -- (per the partial unique index below); `failed` and `superseded`
    -- are terminal and coexist with a fresh attempt for the same
    -- fingerprint without conflict.
    status                  TEXT NOT NULL DEFAULT 'computing'
                            CHECK (status IN ('computing', 'ready', 'failed', 'superseded')),

    -- Lineage. `replaces` is set on a new row produced by a
    -- recompute and points back at the row it supersedes;
    -- `superseded_by` is set on the old row when the new row commits.
    -- ON DELETE SET NULL so 1B-7 retention can prune old rows without
    -- a foreign-key cascade chain. `superseded_by` is DEFERRABLE
    -- INITIALLY DEFERRED so the recompute transaction (§3.5) can pre-
    -- allocate `new_id` from the sequence, mark the old row
    -- `superseded` with `superseded_by=new_id`, then INSERT the new
    -- row with `id=new_id` in the same transaction without tripping
    -- the FK check at statement boundary.
    replaces                BIGINT REFERENCES policy_triage_run(id) ON DELETE SET NULL,
    superseded_by           BIGINT REFERENCES policy_triage_run(id) ON DELETE SET NULL
                            DEFERRABLE INITIALLY DEFERRED,
    refresh_reason          TEXT,

    -- Diagnostics. `last_error` is populated for `failed` rows
    -- (encoding error, transport error, the 1B-7 timeout marker, etc.).
    -- `computation_duration_ms` lets the recompute confirm modal
    -- estimate the wait without re-running the work.
    computation_duration_ms BIGINT,
    last_error              TEXT,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finalized_at            TIMESTAMPTZ,

    -- β-style manual-Send tracking (#572), mirroring `event_group`.
    -- `last_sent_at` / `last_sent_by` are set in the finalize
    -- transaction when a manual Send completes; the Settings indicator
    -- renders "Last sent run" / "Total runs sent" from these columns.
    -- The send is always for one specific operator click, so
    -- `send_count` increments by exactly one per successful Send
    -- regardless of how many multipart batches the run was split into.
    -- `last_sent_by` references `auth_db.accounts(id)` (UUID), no FK.
    last_sent_at            TIMESTAMPTZ,
    last_sent_by            UUID,
    send_count              INTEGER NOT NULL DEFAULT 0
);

-- "One active run per fingerprint". `failed` and `superseded` are
-- intentionally outside the predicate so:
--
--   * Cached-vs-new: a `ready` row claims the slot and is reused.
--   * Concurrency:    a second concurrent INSERT for the same
--                     fingerprint conflicts; the loser re-queries the
--                     existing run.
--   * Zombie recovery:1B-7's timeout transitions a stale `computing`
--                     row to `failed`, immediately freeing the slot.
--   * Recompute:      the supersede transition drops the previous
--                     row out of the slot before the new one enters.
CREATE UNIQUE INDEX policy_triage_run_active_fingerprint
    ON policy_triage_run (
        owner_account_id, period_start, period_end,
        policies_fingerprint, exclusions_fingerprint, baseline_version
    )
    WHERE status IN ('computing', 'ready');

-- 1B-7 retention scans by status + created_at; the index keeps the
-- nightly sweep O(log n).
CREATE INDEX policy_triage_run_status_created_idx
    ON policy_triage_run (status, created_at);
CREATE INDEX policy_triage_run_owner_created_idx
    ON policy_triage_run (owner_account_id, created_at DESC);

CREATE TABLE policy_triaged_event (
    -- One row per (run, event). `run_id` cascades on DELETE so 1B-7
    -- pruning a run cleans up its event rows in the same transaction.
    run_id              BIGINT NOT NULL REFERENCES policy_triage_run(id) ON DELETE CASCADE,
    -- review's RocksDB primary key (i128). Same NUMERIC(39,0) shape
    -- as `baseline_triaged_event.event_key`.
    event_key           NUMERIC(39, 0) NOT NULL,

    -- Event identity / display columns. Subset of what corpus A
    -- stores — corpus B is policy-mode only and does not carry the
    -- baseline-centric snapshot.
    event_time          TIMESTAMPTZ NOT NULL,
    kind                TEXT NOT NULL,
    sensor              TEXT NOT NULL,
    orig_addr           INET,
    orig_port           INTEGER,
    resp_addr           INET,
    resp_port           INTEGER,
    proto               INTEGER,

    -- Normalized exclusion-matching columns. Populated at INSERT time
    -- using the same event-kind mapping as corpus A so 1B-2's DELETE
    -- planner applies to all three persistence tables symmetrically.
    -- NTLM carve-out: NTLM rows leave these three NULL (only IP-based
    -- exclusions can match NTLM via orig_addr / resp_addr).
    host                TEXT,
    dns_query           TEXT,
    uri                 TEXT,

    category            TEXT,
    -- Triage score snapshot — JSONB because corpus B produces a
    -- policy outcome (list of `TriageScore { policyId, score }`),
    -- not a single scalar score. Exact JSON shape is owned by the
    -- runner module.
    policy_triage_snapshot JSONB NOT NULL,

    PRIMARY KEY (run_id, event_key)
);

-- Mirror corpus A's index footprint so 1B-2's DELETE planner can
-- target the same set of columns by index in all three tables.
-- IpAddress exclusion uses CIDR containment (<<, <<=) which a btree
-- on `inet` does NOT index efficiently; use GiST with inet_ops.
CREATE INDEX policy_triaged_event_orig_addr_gist
    ON policy_triaged_event USING gist (orig_addr inet_ops);
CREATE INDEX policy_triaged_event_resp_addr_gist
    ON policy_triaged_event USING gist (resp_addr inet_ops);
CREATE INDEX policy_triaged_event_host_idx
    ON policy_triaged_event (host);
CREATE INDEX policy_triaged_event_dns_query_idx
    ON policy_triaged_event (dns_query);
CREATE INDEX policy_triaged_event_uri_idx
    ON policy_triaged_event (uri);
-- Menu reads filter by run_id + event_time descending.
CREATE INDEX policy_triaged_event_run_event_time_idx
    ON policy_triaged_event (run_id, event_time DESC);

-- ── Triage condition snapshots ─────────────────────────────────────

-- Triage condition snapshots (#472).
--
-- Three per-tenant snapshot tables that make the opaque fingerprint
-- columns on `baseline_triaged_event` and `policy_triage_run`
-- resolvable back to the actual exclusion / policy / baseline content
-- active at ingest or run time. The fingerprints alone are only cache
-- keys: once the source tables (`triage_exclusion`, `triage_policy`,
-- the baseline tunables module) mutate, no row in PostgreSQL can
-- answer "what excluded this row?" / "what scoring rules ran here?"
-- without a snapshot lookup.
--
-- Per #472 these tables are tenant-scoped: the exclusion snapshot
-- captures the fully-merged `global ∪ customer-scoped` union (the
-- same payload `computeExclusionsFingerprint` consumes), so the
-- audit story resolves end-to-end against a single tenant DB with no
-- cross-DB joins. Each rule on the union carries a
-- `scope_first_observed` label captured the first time the
-- fingerprint was observed; a later scope flip does NOT mint a new
-- fingerprint (the matcher de-dup in `compileStoredRowsToActiveSet`
-- collapses them on purpose, per #457).
--
-- Population is governed by the shared exclusion / normalization
-- helper plus the corpus runners (cadence + corpus B), with
-- `ON CONFLICT DO NOTHING` so a second writer is a no-op. Snapshot
-- rows survive as long as any corpus row references the fingerprint
-- plus a 30-day grace period; the dedicated retention sweep
-- (`src/lib/triage/snapshot/retention.ts`) deletes the unreferenced
-- ones.

CREATE TABLE exclusion_snapshot (
    -- Same SHA-256 hex digest stored on
    -- `baseline_triaged_event.exclusions_fp` and
    -- `policy_triage_run.exclusions_fingerprint`. Single PK column
    -- because cache-key equality is the join condition; a snapshot row
    -- is immutable once written (write-once via `ON CONFLICT DO
    -- NOTHING`).
    fingerprint TEXT PRIMARY KEY,
    -- Canonical array payload: `[{ scope_first_observed, kind, value }]`
    -- where `scope_first_observed` ∈ {'global', 'customer'} records the
    -- scope when this fingerprint was first observed. The fingerprint
    -- hashes only the matcher-equivalent `(kind, value)` content
    -- (per `computeExclusionsFingerprint`), so the scope label is
    -- audit metadata, not a matching dimension; a rule that later
    -- moves between scopes does not bump the fingerprint and the
    -- original label is preserved.
    snapshot JSONB NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Tombstone for the two-phase retention sweep. Set by the
    -- snapshot retention job the first sweep that observes
    -- zero references; cleared again if a later corpus row revives
    -- the fingerprint (a stable exclusion set can re-mint the same
    -- fingerprint long after an earlier reference aged out). The
    -- snapshot is deletable only after `unreferenced_since` is older
    -- than the 30-day grace period AND the reference probe still
    -- returns zero. `captured_at` is unsuitable for this gate because
    -- it is fixed at first observation: a long-lived fingerprint
    -- whose references churn at year-old offsets would otherwise be
    -- pruned immediately on the first sweep after its last reference
    -- aged out, with no post-expiration grace at all. See #472.
    unreferenced_since TIMESTAMPTZ
);

CREATE TABLE policy_snapshot (
    -- Same SHA-256 hex digest stored on
    -- `policy_triage_run.policies_fingerprint`.
    fingerprint TEXT PRIMARY KEY,
    -- Canonical array payload:
    -- `[{ id, name_first_observed, packet_attr, confidence, response }]`.
    -- The three rule arrays match `computePoliciesFingerprint`'s
    -- canonicalization exactly, so this row is the canonical answer to
    -- "what scoring rules ran under this fingerprint". `name_first_observed`
    -- is a best-effort human label captured the first time the
    -- fingerprint was seen; the `_first_observed` suffix encodes the
    -- diminished semantics so audit consumers cannot misread it as
    -- "the policy name at run time" (which would require name to enter
    -- the fingerprint canonicalization — explicitly out of scope here).
    -- `created_at` / `updated_at` from `TriagePolicyRow` are excluded:
    -- they describe the policy row, not the run, and `captured_at`
    -- already records when the audit substrate first observed this
    -- fingerprint.
    snapshot JSONB NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- See `exclusion_snapshot.unreferenced_since` for rationale.
    unreferenced_since TIMESTAMPTZ
);

CREATE TABLE baseline_version_snapshot (
    -- Same `baseline_version` tag stored on
    -- `baseline_triaged_event.baseline_version` and
    -- `policy_triage_run.baseline_version`. A tunables bump in
    -- `src/lib/triage/baseline/tunables.ts` requires a new version per
    -- RFC 0001 §10, so one row per version is sufficient and
    -- immutable.
    version TEXT PRIMARY KEY,
    -- Canonical serialization of the entire tunables module for this
    -- version. Captures every exported group:
    --   SELECTOR_WEIGHTS, SELECTOR_SATURATION, TAG_THRESHOLDS,
    --   SLOT_ALLOCATION, FINAL_COUNT, STATISTICS_WINDOW_DAYS,
    --   MAX_TAGS, SELECTOR_TAGS.
    parameters JSONB NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Aimer push state, queue, and inflight tracking ─────────────────

-- Phase 2 ingestion foundation: per-customer push state, durable
-- queue, and inflight ack tracker (sub-issue #591 of #570).

-- Cursor + per-kind sync state + pause toggle.
-- One row per streaming push kind. `policy_run` is intentionally
-- excluded (manual-only, β columns on `policy_triage_run`); `policy_event`
-- is also excluded (queue-only, no cursor).
CREATE TABLE aimer_push_state (
  kind                    TEXT        PRIMARY KEY
                          CHECK (kind IN ('baseline_event', 'story')),
  -- cursor
  last_pushed_event_time  TIMESTAMPTZ,
  last_pushed_event_key   TEXT,
  -- liveness / failure state
  last_synced_at          TIMESTAMPTZ,
  last_error              TEXT,
  -- Pause toggle: is this kind drainable at all. The actual
  -- route-level pause gate; "Sync now" honors it.
  opportunistic_enabled   BOOLEAN     NOT NULL DEFAULT TRUE,
  paused_at               TIMESTAMPTZ,
  paused_by               UUID,                                 -- account_id; cross-DB so no FK
  -- Straggler-scan activation watermark (sub-issue #493). Because
  -- `event_group.created_at` defaults to `now()` (= transaction-START
  -- time, not commit time), a correlator transaction that begins
  -- before a drain reads can commit AFTER the drain advances the
  -- cursor while persisting a row whose `created_at` is BEHIND the
  -- just-advanced cursor. Each drain call therefore additionally scans
  -- `WHERE last_sent_at IS NULL AND created_at <= cursor` — anchored
  -- to this watermark so the scan cannot back-flood pre-activation
  -- history on a freshly-seeded tenant. NULL means "never activated,
  -- do not run the straggler scan yet"; `seedNullCursor` (the first
  -- `next-batch` call with no queue work) sets it to NOW() alongside
  -- the cursor seed. See `src/lib/aimer/phase2/story-push.ts`.
  streaming_activated_at  TIMESTAMPTZ,
  -- Phase 2 push cadence consent flag (#651). Does the client-side
  -- auto-timer (`createPeriodicDrain`, 5-minute interval, mounted on
  -- the dashboard app shell) start for this customer. Opt-in per RFC
  -- 0002 Phase 2: default off so a never-consented tenant never
  -- auto-forwards; does NOT gate manual "Sync now". One logical
  -- per-customer toggle stored on BOTH rows; the Settings toggle
  -- updates both in one statement.
  cadence_enabled         BOOLEAN     NOT NULL DEFAULT FALSE
);

-- Seed one row per streaming kind. Cursors start NULL until the first
-- opportunistic push writes `last_pushed_event_time`;
-- `streaming_activated_at` stays NULL until the first drain seeds it.
INSERT INTO aimer_push_state (kind)
VALUES ('baseline_event'), ('story');

-- Withdraw / refresh / backfill notices waiting to be delivered.
-- The `kind` discriminator maps 1:1 to one aimer-web endpoint + one
-- schema_version so a drain route does not need to inspect payload to
-- pick the destination.
CREATE TABLE aimer_push_queue (
  id                  BIGSERIAL    PRIMARY KEY,
  enqueued_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  kind                TEXT         NOT NULL
                      CHECK (kind IN (
                        'withdraw_baseline_event',
                        'withdraw_story',
                        'withdraw_policy_event',
                        'refresh_baseline_window',
                        'refresh_story_window',
                        'backfill_baseline_window',
                        'backfill_story_window'
                      )),
  payload             JSONB        NOT NULL,
  attempts            INTEGER      NOT NULL DEFAULT 0,
  last_attempt_at     TIMESTAMPTZ,
  last_error          TEXT,
  acked_at            TIMESTAMPTZ,
  acked_context_jti   TEXT
);

CREATE INDEX idx_aimer_push_queue_pending
  ON aimer_push_queue (id)
  WHERE acked_at IS NULL;

-- In-flight ack tracker for the browser-driven drain loop. One row per
-- envelope minted by a `next-batch` route that has been sent to the
-- browser but not yet ack'd via the next call's `acked_context_jti`.
-- TTL-pruned (~2 min) by the `next-batch` route on each call.
CREATE TABLE aimer_push_inflight (
  context_jti                   TEXT         PRIMARY KEY,
  kind                          TEXT         NOT NULL
                                CHECK (kind IN ('baseline_event', 'story', 'policy_event')),
  minted_at                     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  cursor_advance_to_event_time  TIMESTAMPTZ,  -- streaming kinds only; NULL for policy_event
  cursor_advance_to_event_key   TEXT,         -- streaming kinds only; NULL for policy_event
  queue_row_ids                 BIGINT[]     NOT NULL DEFAULT '{}',
  -- Tail sub-payloads produced when a drain route subdivides a queue
  -- payload at push time (sub-issue #571) — e.g. the baseline-event
  -- refresh/backfill enrichment path, where the §6 enrichment fields
  -- added at drain time can push the previously-fitted sub-window past
  -- the shared byte cap. The head sub-payload is delivered this round;
  -- recording the tail here keeps it out of `aimer_push_queue` until
  -- ack-time, so a failed POST cleanly drops it with the inflight
  -- delete (in `recordOnFail`) and the next retry redoes the
  -- subdivision freshly — no duplicate tail rows accumulating across
  -- retries. Each entry is `{ "kind": "<queue_kind>", "payload": <jsonb> }`.
  pending_tail_notices          JSONB        NOT NULL DEFAULT '[]'::jsonb,
  -- Exact id+version set of the Stories signed into the envelope at
  -- mint time (sub-issue #493). Stories are ordered by
  -- `(time_window_end, id)` — event-window ordering, not creation-time
  -- ordering — so a late-arriving row whose `time_window_end` falls
  -- inside an already-minted range would otherwise be β-bumped and
  -- audited at ack without ever appearing in the pushed envelope.
  -- Persisting the delivered set pins ack-time updates to it. Each
  -- entry is `{ "story_id": "<numeric>", "story_version": "<text>" }`.
  pushed_stories                JSONB        NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX idx_aimer_push_inflight_ttl
  ON aimer_push_inflight (minted_at);

-- ── Engagement signals ─────────────────────────────────────────────

-- Triage menu engagement-signal capture (#588) and the Phase 2
-- engagement-driven slot allocation substrate (#589 / RFC 0003).
--
-- Two tables (impressions + actions) live in each tenant DB so the
-- signals share the same physical scope as the corpus they describe.
-- Cross-tenant joins are never required and the tenant DB is the only
-- place where the event_key target (`baseline_triaged_event`) is
-- actually resolvable.
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
--   enforce the contract — the helper does at runtime, decoding the
--   env var and rejecting invalid base64 or anything that decodes to
--   under 32 random bytes.
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

CREATE TABLE engagement_impression (
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
    -- The `baseline_version` tag in effect when the row was projected.
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
    -- dial-down attention. The CHECK pins the allowed stop ids at the
    -- schema level so a stale or buggy producer cannot land a
    -- plausible-but-false stop in the analytics store (the HTTP
    -- parser also rejects unknown stops, but the schema is the
    -- durable contract Phase 2 reads — both layers enforce the same
    -- set).
    strictness_stop     TEXT         NOT NULL
        CHECK (strictness_stop IN ('top5', 'top20', 'top50', 'top80', 'all')),
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
    -- The `engagement_model_version` (RFC 0003 §8.3) whose formula was
    -- in effect when this impression was projected. The writer
    -- (`insertImpressions` in src/lib/triage/engagement/storage.ts)
    -- always supplies the active version.
    engagement_model_version TEXT NOT NULL,
    PRIMARY KEY (menu_load_id, event_key)
);

-- Period / created_at index for the retention sweep and for Phase 2
-- reads that slice impressions by window. `created_at` carries the
-- retention edge; `period_start_ts` carries the analyst's window so
-- both are indexed.
CREATE INDEX engagement_impression_created_at_idx
    ON engagement_impression (created_at);
CREATE INDEX engagement_impression_kind_bucket_idx
    ON engagement_impression (kind, slot_bucket);

-- Composite index supporting the RFC 0003 §7 aggregate's per-bucket
-- scan over the (window, shown_by, strictness_stop) filter. The
-- `engagement_impression_kind_bucket_idx` covers (kind, slot_bucket)
-- but not the additional filters Phase 2 reads slice by. This is the
-- smallest index that covers the canonical aggregate without
-- over-indexing — created_at first so the window-bound BETWEEN prunes
-- early, then the two filter columns, then slot_bucket for the
-- GROUP BY.
CREATE INDEX engagement_impression_phase2_aggregate_idx
    ON engagement_impression (created_at, shown_by, strictness_stop, slot_bucket);

-- Snapshot of the engagement model (RFC 0003 §8.2). One row per
-- `engagement_model_version`; immutable audit record of the formula
-- coefficients and aggregate-SQL digest in effect when an impression
-- was projected.
CREATE TABLE engagement_model_snapshot (
    -- The `engagement_model_version` tag (RFC 0003 §8.1) at the time
    -- the snapshot was captured. PK so a single row per version exists
    -- in the tenant DB; `ON CONFLICT DO NOTHING` semantics on insert.
    version               TEXT         PRIMARY KEY,
    -- Coefficients + guardrail params (RFC 0003 §9.3). JSONB so future
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

CREATE TABLE engagement_action (
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
    -- `STRICTNESS_STOPS`). The CHECK pins the allowed ids at the
    -- schema level (matching the engagement_impression.strictness_stop
    -- CHECK) so a malformed producer cannot persist a
    -- plausible-but-false stop. The constraint is permissive of NULL
    -- because non-strictness_change action types leave both columns
    -- NULL — the action-shape CHECK already enforces that they are
    -- NOT NULL for `strictness_change` rows.
    strictness_from     TEXT
        CHECK (strictness_from IS NULL
            OR strictness_from IN ('top5', 'top20', 'top50', 'top80', 'all')),
    strictness_to       TEXT
        CHECK (strictness_to IS NULL
            OR strictness_to IN ('top5', 'top20', 'top50', 'top80', 'all')),
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    -- The menu load that surfaced the row the action addresses (RFC
    -- 0003 §2.2). Row-bound action types require it; non-row-bound
    -- types must leave it NULL — the shape CHECK enforces both
    -- directions.
    menu_load_id        UUID,
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
                AND menu_load_id IS NOT NULL
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
                AND menu_load_id IS NOT NULL
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
);

CREATE INDEX engagement_action_created_at_idx
    ON engagement_action (created_at);
CREATE INDEX engagement_action_type_created_at_idx
    ON engagement_action (action_type, created_at);
CREATE INDEX engagement_action_event_key_idx
    ON engagement_action (event_key)
    WHERE event_key IS NOT NULL;

-- RFC 0003 §7 numerator JOIN scans `engagement_action` on
-- (menu_load_id, event_key). `engagement_action_event_key_idx` covers
-- the second half of the JOIN predicate; a partial index on
-- menu_load_id (defined only where it is populated) covers the first
-- half without bloating the action table's footprint with NULL rows.
CREATE INDEX engagement_action_menu_load_id_idx
    ON engagement_action (menu_load_id, event_key)
    WHERE menu_load_id IS NOT NULL;

-- ── Aimer Phase 2 manual-send ledgers ──────────────────────────────

-- Manual Send-to-aimer-web mint ledger (sub-issue #493).
--
-- The manual Send path mints a single-Story Phase 2 envelope server-
-- side via `POST /api/aimer/phase2/story/build-envelope`, hands the
-- multipart tokens to the browser, and waits for the browser's
-- `POST /api/aimer/phase2/story/ack-manual` call (which fires after
-- aimer-web returns 2xx). The browser cannot mutate the tenant DB
-- directly, so this ledger backs the replay/forgery guard on
-- `ack-manual`: each `build-envelope` INSERTs one row keyed on the
-- minted `context_jti`, and `ack-manual` SELECTs ... FOR UPDATE on
-- the same JTI before consuming it + bumping the `event_group` β
-- columns in the same tenant-DB transaction.
CREATE TABLE aimer_phase2_manual_mint (
    context_jti   TEXT             PRIMARY KEY,
    story_id      NUMERIC(39, 0)   NOT NULL,
    -- `accounts.id` lives in the auth DB; cross-DB so no FK. App-level
    -- integrity is enough — the consume side checks `account_id` ==
    -- the calling session's account.
    account_id    UUID             NOT NULL,
    force_refresh BOOLEAN          NOT NULL,
    minted_at     TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    -- NULL until the matching `ack-manual` call commits. The
    -- replay/forgery guard rejects a SELECT that finds `consumed_at IS
    -- NOT NULL` with 409 `replay_or_unknown_jti`.
    consumed_at   TIMESTAMPTZ
);

-- Sweep helper: the retention job reaps rows older than 24h (consumed
-- or not), so an index on `minted_at` keeps the sweep cheap. Matches
-- the pattern used by the `aimer_push_queue` retention.
CREATE INDEX aimer_phase2_manual_mint_minted_at_idx
    ON aimer_phase2_manual_mint (minted_at);

-- Policy-run manual-Send inflight ledger (sub-issue #572).
--
-- A separate inflight table from `aimer_push_inflight` because the
-- policy-run Send lifecycle is distinct: one operator action mints N
-- batches sharing one `send_action_id`, each batch has its own
-- `context_jti`, and the finalize route consumes the full set at once.
-- Reusing `aimer_push_inflight` would tangle these rows with the
-- streaming drain's `cursor_advance_to_event_time` / `queue_row_ids`
-- columns that are meaningless for a one-shot Send, and would force a
-- different TTL than the streaming kinds
-- (`POLICY_RUN_SEND_INFLIGHT_TTL_SECONDS = 600` vs
-- `PHASE2_INFLIGHT_TTL_SECONDS = 120`).
CREATE TABLE aimer_policy_run_send_inflight (
    -- Mint-time JTI of the per-batch envelope. Primary key so a duplicate
    -- mint of the same JTI is rejected outright; pairs with the
    -- per-batch UNIQUE constraint below to defend the table against both
    -- shapes of duplicate-mint bugs.
    context_jti          TEXT        PRIMARY KEY,

    -- Operator-action correlator. Browser mints one UUID per Send click;
    -- every batch and the finalize call share the same value. The
    -- finalize route uses it (with `run_id` and `actor_account_id`) to
    -- locate the inflight rows for set-equality validation.
    send_action_id       UUID        NOT NULL,

    -- Cascades so deleting the source run cleans up any abandoned
    -- inflight rows (the TTL prune would catch them too, but cascade
    -- keeps cleanup synchronous when a run is hard-deleted).
    run_id               BIGINT      NOT NULL REFERENCES policy_triage_run(id) ON DELETE CASCADE,

    -- Session account that initiated the Send. Cross-DB so no FK; the
    -- finalize route cross-checks this against the session's effective
    -- account so a different operator cannot finalize someone else's
    -- Send even if they guess the `send_action_id`.
    actor_account_id     UUID        NOT NULL,

    -- Zero-based batch index within the Send. Used by finalize to map
    -- `batch_acks` entries back to the inflight rows and to detect a
    -- missing middle batch.
    batch_index          INTEGER     NOT NULL,

    -- True on the final batch of a Send (the one with `has_more = false`
    -- at build-envelope time). Finalize rejects when this row is missing
    -- from `batch_acks`, so a truncated multi-batch Send cannot quietly
    -- commit β / audit on a partial set.
    is_terminal          BOOLEAN     NOT NULL DEFAULT FALSE,

    -- Exclusive upper bound (`event_key`) of the slice this batch
    -- represents, captured at mint time so a retry of the same
    -- `send_action_id` can reproduce the same slice cursor. Null only
    -- for an empty-run Send (no events; one terminal batch with no
    -- slice).
    last_event_key       NUMERIC(39, 0),

    -- Exclusive lower bound (`event_key`) of the slice — the
    -- `after_event_key` cursor the build-envelope call was made with.
    -- Null on the first batch of a Send. Together with `send_action_id`
    -- this is the cursor identity of the batch; the partial unique
    -- indexes below catch a sequential retry of the same call (same
    -- send action, same cursor) so the route returns 409 instead of
    -- minting a duplicate batch with a fresh JTI.
    after_event_key      NUMERIC(39, 0),

    minted_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Catch duplicate-mint bugs at the DB level: one batch_index per
    -- send action. The build-envelope route translates the unique
    -- violation to a 409 Conflict with `duplicate_batch_for_send_action`.
    UNIQUE (send_action_id, batch_index)
);

CREATE INDEX idx_aimer_policy_run_send_inflight_action
    ON aimer_policy_run_send_inflight (send_action_id);
CREATE INDEX idx_aimer_policy_run_send_inflight_run
    ON aimer_policy_run_send_inflight (run_id, send_action_id);
CREATE INDEX idx_aimer_policy_run_send_inflight_ttl
    ON aimer_policy_run_send_inflight (minted_at);

-- Cursor-identity uniqueness. Split into two partial indexes so the
-- NULL-cursor first batch is also covered: PostgreSQL treats NULLs as
-- distinct in a plain UNIQUE constraint, which would allow two "first
-- batch" rows for the same send_action_id (the exact sequential-retry
-- bug we want to catch). Both indexes raise the same SQLSTATE 23505,
-- which the build-envelope route translates to
-- `duplicate_batch_for_send_action`.
CREATE UNIQUE INDEX uniq_aimer_policy_run_send_inflight_cursor_notnull
    ON aimer_policy_run_send_inflight (send_action_id, after_event_key)
    WHERE after_event_key IS NOT NULL;
CREATE UNIQUE INDEX uniq_aimer_policy_run_send_inflight_cursor_null
    ON aimer_policy_run_send_inflight (send_action_id)
    WHERE after_event_key IS NULL;
