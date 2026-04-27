-- Phase Node-9c (#361, review round 8): preserve succeeded-audit-pending
-- rows when the creator account is deleted.
--
-- Round 8 reviewer finding: the audit recovery sweep selects from
-- `apply_attempts` to backfill `node.apply` for rows that reached
-- `succeeded` but never made it through `succeeded_audit_completed_at`.
-- Until round 8 the table's `created_by` FK was
-- `ON DELETE CASCADE REFERENCES accounts(id)`, so deleting the creator
-- would cascade-remove the row out from under the recovery sweep — a
-- succeeded-audit-pending attempt could end up with zero `node.apply`
-- entries even though the schema-level `node.apply` correlation index
-- + slot machinery had been doing their job up to that point.
--
-- Two changes here decouple cascade behavior from audit-recovery
-- durability:
--
--   1. `audit_actor UUID NOT NULL` — a snapshot of the creator's
--      account id taken at insert time, with NO foreign key. The
--      `recoverPendingNodeApplyAudits` sweep reads this column for the
--      audit `actor` field instead of `created_by`, so deleting the
--      account cannot strip the actor from a pending recovery.
--
--   2. `created_by` FK switches from `ON DELETE CASCADE` to
--      `ON DELETE SET NULL`, and the column is made nullable. A
--      BEFORE DELETE trigger on `accounts` then explicitly removes
--      apply_attempts rows that are NOT succeeded-audit-pending so
--      the umbrella's "cascade-delete removes the attempt row" rule
--      still holds for the common case (round-4 acceptance test on
--      `failed_retryable`). The remaining rows — `status = 'succeeded'`
--      AND `succeeded_audit_completed_at IS NULL` — survive with
--      `created_by = NULL`, which makes the lifecycle's ownership
--      check (`row.createdBy !== session.accountId`) reject any
--      follow-up confirm / retry as `ApplyAttemptNotFoundError` (the
--      observable surface a user sees is unchanged), while the
--      recovery sweep keeps the row visible and emits `node.apply`
--      using the snapshotted `audit_actor`.
--
-- Idempotent: safe to re-run.

-- Step 1: add the snapshot column. Backfill from the existing
-- `created_by` for rows that already exist before this migration runs.
ALTER TABLE apply_attempts
  ADD COLUMN IF NOT EXISTS audit_actor UUID;

UPDATE apply_attempts
  SET audit_actor = created_by
  WHERE audit_actor IS NULL;

ALTER TABLE apply_attempts
  ALTER COLUMN audit_actor SET NOT NULL;

-- Step 2: relax the FK on `created_by` so account deletion does not
-- cascade-remove succeeded-audit-pending rows. The trigger below
-- handles the cascade for non-pending rows.
ALTER TABLE apply_attempts
  ALTER COLUMN created_by DROP NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'apply_attempts'
      AND constraint_type = 'FOREIGN KEY'
      AND constraint_name = 'apply_attempts_created_by_fkey'
  ) THEN
    ALTER TABLE apply_attempts
      DROP CONSTRAINT apply_attempts_created_by_fkey;
  END IF;
END $$;

ALTER TABLE apply_attempts
  ADD CONSTRAINT apply_attempts_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES accounts(id) ON DELETE SET NULL;

-- Step 3: trigger that preserves the cascade-delete observable for
-- non-audit-pending rows. Runs BEFORE the `accounts` row is actually
-- deleted, so the explicit DELETE here happens before the FK SET NULL
-- action fires for survivors.
CREATE OR REPLACE FUNCTION cascade_apply_attempts_on_account_delete()
  RETURNS TRIGGER
  LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM apply_attempts
  WHERE created_by = OLD.id
    AND NOT (
      status = 'succeeded'
      AND succeeded_audit_completed_at IS NULL
    );
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS cascade_apply_attempts_on_account_delete
  ON accounts;

CREATE TRIGGER cascade_apply_attempts_on_account_delete
  BEFORE DELETE ON accounts
  FOR EACH ROW
  EXECUTE FUNCTION cascade_apply_attempts_on_account_delete();
