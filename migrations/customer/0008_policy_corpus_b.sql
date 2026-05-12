-- Triage policy corpus B schema (1B-6 / discussion #447 §3.4-3.5).
--
-- Two tables in every customer-tenant DB. The corpus B runner
-- (src/lib/triage/policy/corpus-b/) creates one `policy_triage_run`
-- per user-triggered "With my policies" request and fills
-- `policy_triaged_event` with the per-event triage outcome for that
-- run. Each run's identity is the tuple
-- `(owner_account_id, period_start, period_end,
--   policies_fingerprint, exclusions_fingerprint, baseline_version)`;
-- the partial unique index on `(status IN ('computing', 'ready'))`
-- enforces "one active run per fingerprint" while letting
-- `failed` / `superseded` rows accumulate for diagnostics.
--
-- `owner_account_id` references `auth_db.accounts(id)`. PostgreSQL
-- does not support cross-database foreign keys, so existence is
-- enforced at the application layer: the API checks the caller's
-- account exists when creating a run, the menu filters out runs
-- whose `owner_account_id` no longer resolves at read time, and
-- corpus B cleanup (1B-7) eventually removes orphans.
--
-- The normalized exclusion-matching columns (`orig_addr`, `resp_addr`,
-- `host`, `dns_query`, `uri`) mirror corpus A so 1B-2's retroactive
-- DELETE planner applies symmetrically across all three persistence
-- tables.

CREATE TABLE IF NOT EXISTS policy_triage_run (
    -- BIGSERIAL so the recompute transaction can pre-allocate `new_id`
    -- before the supersede-then-INSERT pair commits.
    id                      BIGSERIAL PRIMARY KEY,

    -- Account that triggered the run. UUID NOT NULL to match
    -- `auth_db.accounts(id)`. Cross-DB FK is not supported; the
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
    -- a foreign-key cascade chain.
    replaces                BIGINT REFERENCES policy_triage_run(id) ON DELETE SET NULL,
    superseded_by           BIGINT REFERENCES policy_triage_run(id) ON DELETE SET NULL,
    refresh_reason          TEXT,

    -- Diagnostics. `last_error` is populated for `failed` rows
    -- (encoding error, transport error, the 1B-7 timeout marker, etc.).
    -- `computation_duration_ms` lets the recompute confirm modal
    -- estimate the wait without re-running the work.
    computation_duration_ms BIGINT,
    last_error              TEXT,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finalized_at            TIMESTAMPTZ
);

-- "One active run per fingerprint" — see §3.5 "Active-fingerprint
-- uniqueness via partial unique index" in the issue body. `failed`
-- and `superseded` are intentionally outside the predicate so:
--
--   * Cached-vs-new: a `ready` row claims the slot and is reused.
--   * Concurrency:    a second concurrent INSERT for the same
--                     fingerprint conflicts; the loser re-queries the
--                     existing run.
--   * Zombie recovery:1B-7's timeout transitions a stale `computing`
--                     row to `failed`, immediately freeing the slot.
--   * Recompute:      the supersede transition drops the previous
--                     row out of the slot before the new one enters.
CREATE UNIQUE INDEX IF NOT EXISTS policy_triage_run_active_fingerprint
    ON policy_triage_run (
        owner_account_id, period_start, period_end,
        policies_fingerprint, exclusions_fingerprint, baseline_version
    )
    WHERE status IN ('computing', 'ready');

-- 1B-7 retention scans by status + created_at; the index keeps the
-- nightly sweep O(log n).
CREATE INDEX IF NOT EXISTS policy_triage_run_status_created_idx
    ON policy_triage_run (status, created_at);
CREATE INDEX IF NOT EXISTS policy_triage_run_owner_created_idx
    ON policy_triage_run (owner_account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS policy_triaged_event (
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
    -- not a single scalar baseline_score. Exact JSON shape is owned
    -- by the runner module.
    policy_triage_snapshot JSONB NOT NULL,

    PRIMARY KEY (run_id, event_key)
);

-- Mirror corpus A's index footprint so 1B-2's DELETE planner can
-- target the same set of columns by index in all three tables.
-- IpAddress exclusion uses CIDR containment (<<, <<=) which a btree
-- on `inet` does NOT index efficiently; use GiST with inet_ops.
CREATE INDEX IF NOT EXISTS policy_triaged_event_orig_addr_gist
    ON policy_triaged_event USING gist (orig_addr inet_ops);
CREATE INDEX IF NOT EXISTS policy_triaged_event_resp_addr_gist
    ON policy_triaged_event USING gist (resp_addr inet_ops);
CREATE INDEX IF NOT EXISTS policy_triaged_event_host_idx
    ON policy_triaged_event (host);
CREATE INDEX IF NOT EXISTS policy_triaged_event_dns_query_idx
    ON policy_triaged_event (dns_query);
CREATE INDEX IF NOT EXISTS policy_triaged_event_uri_idx
    ON policy_triaged_event (uri);
-- Menu reads filter by run_id + event_time descending.
CREATE INDEX IF NOT EXISTS policy_triaged_event_run_event_time_idx
    ON policy_triaged_event (run_id, event_time DESC);
