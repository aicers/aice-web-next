-- Triage condition snapshots (#472).
--
-- Three per-tenant snapshot tables that make the opaque fingerprint
-- columns on `baseline_triaged_event` (#456) and `policy_triage_run`
-- (#460) resolvable back to the actual exclusion / policy / baseline
-- content active at ingest or run time. The fingerprints alone are
-- only cache keys: once the source tables (`triage_exclusion`,
-- `triage_policy`, the baseline tunables module) mutate, no row in
-- PostgreSQL can answer "what excluded this row?" / "what scoring
-- rules ran here?" without a snapshot lookup.
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

CREATE TABLE IF NOT EXISTS exclusion_snapshot (
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
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS policy_snapshot (
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
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS baseline_version_snapshot (
    -- Same `baseline_version` tag stored on
    -- `baseline_triaged_event.baseline_version` and
    -- `policy_triage_run.baseline_version`. Today that tag is
    -- "phase1b-four-selector" from `src/lib/triage/baseline/cadence.ts`;
    -- a bump in `src/lib/triage/baseline/tunables.ts` requires a new
    -- version per its §10, so one row per version is sufficient and
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
