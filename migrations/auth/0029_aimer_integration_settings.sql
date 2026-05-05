-- Aimer integration system settings (#437).
--
-- Two new keys join `system_settings` to identify the deployment to
-- aimer-web (`aice_id`) and to point at aimer-web's bridge endpoint
-- (`aimer_web_bridge_url`).  Both ship with `null` values so the
-- Setup status starts in the "Not configured" state and the
-- operator must enter them via the admin UI.
--
-- The third Send-to-Aimer prerequisite (the context-token signing
-- keypair) lives on disk under `data/keys/aimer-context-signing.json`,
-- not in `system_settings` — see `src/lib/aimer/signing-key.ts`.
INSERT INTO system_settings (key, value) VALUES
  ('aice_id', 'null'::jsonb),
  ('aimer_web_bridge_url', 'null'::jsonb);
