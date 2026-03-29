CREATE TABLE webauthn_credentials (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  credential_id   BYTEA NOT NULL,
  public_key      BYTEA NOT NULL,
  counter         BIGINT NOT NULL DEFAULT 0,
  transports      TEXT[],
  display_name    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at    TIMESTAMPTZ,
  CONSTRAINT uq_webauthn_credential_id UNIQUE (credential_id)
);

CREATE INDEX idx_webauthn_account ON webauthn_credentials (account_id);

CREATE TABLE webauthn_registration_challenges (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL,
  challenge   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_webauthn_reg_challenge_account ON webauthn_registration_challenges (account_id);
CREATE INDEX idx_webauthn_reg_challenge_expires ON webauthn_registration_challenges (expires_at);

CREATE TABLE webauthn_authentication_challenges (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL,
  challenge   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_webauthn_auth_challenge_account ON webauthn_authentication_challenges (account_id);
CREATE INDEX idx_webauthn_auth_challenge_expires ON webauthn_authentication_challenges (expires_at);
