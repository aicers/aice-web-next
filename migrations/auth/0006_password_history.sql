CREATE TABLE password_history (
  id            BIGSERIAL PRIMARY KEY,
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_password_history_account_created
  ON password_history (account_id, created_at DESC);
