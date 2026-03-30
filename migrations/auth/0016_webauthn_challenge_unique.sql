-- Ensure at most one pending challenge per account.
-- An UPSERT in the application layer replaces any existing challenge
-- when the user re-requests registration/authentication options.

ALTER TABLE webauthn_registration_challenges
  ADD CONSTRAINT uq_webauthn_reg_challenge_account UNIQUE (account_id);

ALTER TABLE webauthn_authentication_challenges
  ADD CONSTRAINT uq_webauthn_auth_challenge_account UNIQUE (account_id);
