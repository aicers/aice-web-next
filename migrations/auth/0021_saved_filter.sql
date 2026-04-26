-- Personal saved filters for the Detection page (#286).
--
-- v1 stores only personal entries — `owner_account_id` references
-- `accounts(id)` and `UNIQUE(owner_account_id, name)` enforces per-user
-- unique names. Tenant/team sharing is out of scope for v1.
--
-- The `mode` column is introduced now so a future search-language phase
-- can insert `mode = 'query'` rows alongside today's `mode = 'structured'`
-- payloads without another migration. v1 server actions only insert
-- `mode = 'structured'`; load paths branch on `mode` and reject unknown
-- modes gracefully. The `filter_json` payload shape depends on `mode`:
-- structured → serialized `EventListFilterInput`; query → `{ text: ... }`.

CREATE TABLE saved_filter (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  mode             TEXT NOT NULL DEFAULT 'structured'
                     CHECK (mode IN ('structured', 'query')),
  filter_json      JSONB NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner_account_id, name)
);

CREATE INDEX saved_filter_owner_idx
  ON saved_filter (owner_account_id, updated_at DESC);
