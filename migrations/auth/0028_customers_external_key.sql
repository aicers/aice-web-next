-- Aimer-bridge customer mapping (#438): add `external_key` to the
-- `customers` table so an aice-web-next customer can be paired with the
-- matching customer on the aimer-web side via a globally unique
-- operator-agreed identifier.
--
-- Background. aimer-web's `auth_db.customers` already carries
-- `external_key TEXT NOT NULL UNIQUE` (its
-- `migrations/auth/0002_customers.sql`). aice-web-next previously had
-- no equivalent column, so the Send to Aimer flow had no value to put
-- into the context token's `customer_ids` claim that aimer-web could
-- map back to a customer UUID.
--
-- The constraint is global UNIQUE to mirror aimer-web. A single
-- billing / unified-management business entity may be linked to
-- multiple AICE environments via aimer-web's
-- `aice_environment_customers`, so the key is one-to-many in that
-- direction but unique per repo.
--
-- For the first cycle, `external_key` is NULL-allowed: operators
-- populate it on a per-customer basis at their own pace, and customers
-- without it are non-eligible for Send to Aimer (the per-customer gate
-- in #440 disables the action). A future migration may tighten this
-- to NOT NULL once the rollout is complete.
--
-- Idempotent: safe to re-run.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS external_key TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customers_external_key_key'
      AND conrelid = 'customers'::regclass
  ) THEN
    ALTER TABLE customers
      ADD CONSTRAINT customers_external_key_key UNIQUE (external_key);
  END IF;
END$$;
