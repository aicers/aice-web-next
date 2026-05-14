-- Extend the fanout queue so customer-scoped ADD drain failures and
-- admin recovery resets share one queue with the global-fanout path
-- (#461 / 1B-7).
--
-- Two changes:
--   1. `global_exclusion_id` becomes nullable. A queue row may carry
--      EITHER a global-exclusion id (the original 1B-2 fanout path) OR
--      a customer-only-exclusion id (the new 1B-7 customer drain-failure
--      sentinel) — never both, never neither. A CHECK enforces the
--      XOR. Both keep their existing semantics; the row's "kind" is
--      derived from which column is populated.
--   2. Two partial unique indexes deduplicate per logical scope so
--      reset-in-place recovery (which UPDATEs `status='failed'` rows
--      to `pending` with `attempt_count=0`) cannot race a stale insert
--      path into producing two rows for the same exclusion+customer
--      pair. Without these, the admin UI would see two "Re-trigger
--      cleanup" entries and `FOR UPDATE SKIP LOCKED` would have
--      ambiguous claim semantics.
--
-- `customer_only_exclusion_id` deliberately has no FK because the
-- referenced tenant `triage_exclusion` row lives in a per-customer DB
-- and PostgreSQL does not support cross-database foreign keys.
-- Existence is enforced at the application layer (see the recover
-- route and the fanout worker's missing-tenant-row branch).
--
-- Idempotent: safe to re-run.

ALTER TABLE triage_exclusion_fanout_job
    ALTER COLUMN global_exclusion_id DROP NOT NULL;

ALTER TABLE triage_exclusion_fanout_job
    ADD COLUMN IF NOT EXISTS customer_only_exclusion_id UUID;

-- Drop and re-add the XOR CHECK so re-running the migration after a
-- partial migration is idempotent and the constraint name is stable.
ALTER TABLE triage_exclusion_fanout_job
    DROP CONSTRAINT IF EXISTS triage_exclusion_fanout_job_scope_xor_chk;
ALTER TABLE triage_exclusion_fanout_job
    ADD CONSTRAINT triage_exclusion_fanout_job_scope_xor_chk
    CHECK (
        (global_exclusion_id IS NOT NULL)::int
        + (customer_only_exclusion_id IS NOT NULL)::int = 1
    );

-- Dedupe per (global_exclusion_id, customer_id). With this in place
-- the customer-drain sentinel insert and any future re-enqueue path
-- can use `ON CONFLICT (...) DO UPDATE SET status='pending', ...`
-- so the dedupe behavior collapses naturally into "reset the existing
-- row".
CREATE UNIQUE INDEX IF NOT EXISTS triage_exclusion_fanout_job_global_dedupe
    ON triage_exclusion_fanout_job (global_exclusion_id, customer_id)
    WHERE global_exclusion_id IS NOT NULL;

-- Dedupe per (customer_only_exclusion_id, customer_id). The customer
-- id is always populated; without it a SELECT for "is there a sentinel
-- row for this exclusion" still has to scan, so we still include it in
-- the index even though every customer_only row carries exactly one.
CREATE UNIQUE INDEX IF NOT EXISTS triage_exclusion_fanout_job_customer_dedupe
    ON triage_exclusion_fanout_job (customer_only_exclusion_id, customer_id)
    WHERE customer_only_exclusion_id IS NOT NULL;
