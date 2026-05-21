-- Aimer analyze-bridge default model settings (#629).
--
-- aimer-web's POST /api/analysis/analyze-bridge embeds the analyze
-- parameters in a signed JWS (`analyze_params_token`); `model_name`
-- and `model` are required claims on that token. aice-web-next mints
-- the JWS server-side from these two system settings (Decision 3 in
-- the rewire issue body — per-request override is intentionally out
-- of scope here; option (c) "let aimer-web pick a default" was ruled
-- out because aimer-web#254 made the analyze fields required).
INSERT INTO system_settings (key, value) VALUES
  ('aimer_default_model_name', 'null'::jsonb),
  ('aimer_default_model', 'null'::jsonb);
