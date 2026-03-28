CREATE TABLE mfa_challenges (
  jti        UUID PRIMARY KEY,
  account_id UUID NOT NULL,
  used       BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_mfa_challenges_expires ON mfa_challenges (expires_at);
