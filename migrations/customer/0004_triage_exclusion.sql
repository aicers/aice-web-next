-- Customer-scoped triage exclusions storage (1B-2 / discussion #447 §3.4).
--
-- Lives in each tenant DB so a single exclusion row never needs a
-- `customer_id` column — the database itself is the customer scope,
-- mirroring `triage_policy` (#459) and the corpus A tables (#456).
--
-- Same column shape as `auth_db.global_triage_exclusion` so the shared
-- exclusion helper can union them transparently. The only differences:
--   - placement (`auth_db` vs each tenant DB)
--   - `created_by` is a plain UUID with no FK, because PostgreSQL does
--     not support cross-database foreign keys. Existence of the
--     referenced account in `auth_db.accounts` is enforced at the
--     application layer.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS triage_exclusion (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind          TEXT NOT NULL CHECK (kind IN ('ipAddress', 'hostname', 'uri', 'domain')),
    value         TEXT NOT NULL,
    domain_suffix TEXT,
    note          TEXT,
    -- UUID of the account in `auth_db.accounts`. Cross-DB FKs are not
    -- supported, so existence is enforced at the application layer
    -- (same pattern as `policy_triage_run.owner_account_id` from #460).
    created_by    UUID NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (kind, value)
);
CREATE INDEX IF NOT EXISTS triage_exclusion_kind_idx
    ON triage_exclusion (kind);
