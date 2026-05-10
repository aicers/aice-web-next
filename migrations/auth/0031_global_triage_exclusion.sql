-- Global triage exclusions storage (1B-2 / discussion #447 §3.4).
--
-- Lives in `auth_db` because the table is ops-managed and globally
-- scoped; per-tenant exclusions live in each tenant DB
-- (`migrations/customer/0004_triage_exclusion.sql`).
--
-- Both tables share the column shape so the shared exclusion helper
-- (`src/lib/triage/exclusion/`) can union them transparently. They
-- differ only in placement and in whether `created_by` references
-- `accounts(id)` directly — only the global table can, because
-- PostgreSQL does not support cross-database FKs.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS global_triage_exclusion (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Exclusion kind. CHECK-constrained so a typo never silently
    -- disables matching.
    kind          TEXT NOT NULL CHECK (kind IN ('ipAddress', 'hostname', 'uri', 'domain')),
    -- User-supplied value, stored AFTER normalization. Semantics by
    -- kind:
    --   ipAddress: canonical CIDR ('192.168.1.0/24'); single IPs upgraded to /32 or /128
    --   hostname:  lowercased, trailing dot stripped
    --   uri:       byte-for-byte as supplied (exact-match semantics)
    --   domain:    regex pattern, exactly as supplied
    value         TEXT NOT NULL,
    -- Suffix-normalized form for `domain` rows that reduce to a
    -- hostname suffix or exact hostname. NULL when kind is `domain`
    -- but the regex is not suffix-reducible, and NULL when kind is
    -- not `domain`. Populated at INSERT so the retroactive DELETE
    -- planner does not re-run the reducer per ADD.
    domain_suffix TEXT,
    note          TEXT,
    -- ON DELETE RESTRICT: an account whose name is on a live exclusion
    -- cannot be hard-deleted (audit-relevant authorship). Account
    -- soft-deletion still succeeds; the row simply remains attributed.
    created_by    UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Same (kind, value) cannot appear twice. Normalization is applied
    -- before INSERT so a plain UNIQUE on the stored form suffices.
    UNIQUE (kind, value)
);
CREATE INDEX IF NOT EXISTS global_triage_exclusion_kind_idx
    ON global_triage_exclusion (kind);
