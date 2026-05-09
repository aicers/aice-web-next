-- Triage policy CRUD storage (1B-5 / discussion #447 §2.1).
--
-- Lives in the per-customer tenant DB so a single policy row never
-- needs a `customer_id` column — the database itself is the scope.
-- Rule lists are stored as JSONB; their structural validation is done
-- at the application layer (see src/lib/triage/policy/validation.ts).
--
-- Per the deprecatability seam in §6 of #447, this migration owns the
-- entire policy schema in one file. A future deprecation of the
-- corpus-B / TriagePolicy feature drops the table and removes this
-- file in one step, leaving the rest of the tenant schema untouched.

-- `id` is INTEGER (not BIGINT) so node-postgres returns it as a JS
-- number rather than a string — matches the `TriagePolicyRow.id:
-- number` contract in src/lib/triage/policy/types.ts and lines up
-- with the GraphQL `Int` path described in #447 §2.1 for the
-- inline-policy id surface.
CREATE TABLE IF NOT EXISTS triage_policy (
  id           SERIAL PRIMARY KEY,
  name         TEXT        NOT NULL,
  packet_attr  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  confidence   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  response     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS triage_policy_name_key
  ON triage_policy (name);
