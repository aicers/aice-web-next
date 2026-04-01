-- Replace the unused accounts.mfa_required BOOLEAN with a
-- constrained mfa_override TEXT column that supports three
-- states: NULL (follow role default), 'exempt', 'required'.
ALTER TABLE accounts DROP COLUMN mfa_required;
ALTER TABLE accounts
  ADD COLUMN mfa_override TEXT CHECK (mfa_override IN ('exempt', 'required'));

-- Set System Administrator role to require MFA by default
UPDATE roles SET mfa_required = true WHERE name = 'System Administrator';

-- Recovery codes (10 per account, hashed)
CREATE TABLE recovery_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  used        BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at     TIMESTAMPTZ
);

CREATE INDEX idx_recovery_codes_account ON recovery_codes (account_id);

-- Session-level flag for mandatory MFA enrollment
ALTER TABLE sessions ADD COLUMN must_enroll_mfa BOOLEAN NOT NULL DEFAULT false;
