-- Add session policy enforcement columns.
-- needs_reauth: flags sessions that require re-authentication due to
-- IP/UA changes (risk-based step-up auth per Discussion #32 §8.2).
-- browser_fingerprint: normalized "Family/Major" string for efficient
-- UA comparison without reparsing the full user_agent on every request.

ALTER TABLE sessions
  ADD COLUMN needs_reauth BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN browser_fingerprint TEXT NOT NULL DEFAULT '';
