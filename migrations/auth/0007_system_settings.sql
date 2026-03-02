CREATE TABLE system_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO system_settings (key, value) VALUES
  ('password_policy', '{
    "min_length": 12,
    "max_length": 128,
    "complexity_enabled": false,
    "reuse_ban_count": 5,
    "periodic_change_enabled": false,
    "periodic_change_days": null
  }'::jsonb),
  ('session_policy', '{
    "idle_timeout_minutes": 30,
    "absolute_timeout_hours": 8,
    "max_sessions": null
  }'::jsonb),
  ('lockout_policy', '{
    "stage1_threshold": 5,
    "stage1_duration_minutes": 30,
    "stage2_threshold": 3
  }'::jsonb),
  ('signin_rate_limit', '{
    "per_ip_count": 20,
    "per_ip_window_minutes": 5,
    "per_account_ip_count": 5,
    "per_account_ip_window_minutes": 5,
    "global_count": 100,
    "global_window_minutes": 1
  }'::jsonb),
  ('api_rate_limit', '{
    "per_user_count": 100,
    "per_user_window_minutes": 1
  }'::jsonb),
  ('jwt_policy', '{
    "access_token_expiration_minutes": 15
  }'::jsonb),
  ('mfa_policy', '{
    "allowed_methods": ["webauthn", "totp"]
  }'::jsonb);
