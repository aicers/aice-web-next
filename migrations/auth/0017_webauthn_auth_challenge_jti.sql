-- Tie authentication challenges to a specific login attempt (jti)
-- instead of just the account, so concurrent sign-in attempts from
-- different tabs/devices don't overwrite each other's challenges.

ALTER TABLE webauthn_authentication_challenges
  ADD COLUMN jti UUID;

-- Backfill any existing rows (unlikely in practice).
UPDATE webauthn_authentication_challenges
  SET jti = gen_random_uuid()
  WHERE jti IS NULL;

ALTER TABLE webauthn_authentication_challenges
  ALTER COLUMN jti SET NOT NULL;

-- Replace per-account uniqueness with per-login-attempt uniqueness.
ALTER TABLE webauthn_authentication_challenges
  DROP CONSTRAINT uq_webauthn_auth_challenge_account;

ALTER TABLE webauthn_authentication_challenges
  ADD CONSTRAINT uq_webauthn_auth_challenge_jti UNIQUE (jti);
