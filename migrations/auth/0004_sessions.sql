CREATE TABLE sessions (
  sid            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ip_address     TEXT NOT NULL,
  user_agent     TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked        BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_sessions_account_id ON sessions (account_id);
