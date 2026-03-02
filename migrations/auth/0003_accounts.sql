CREATE TABLE accounts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username              TEXT NOT NULL UNIQUE,
  display_name          TEXT NOT NULL,
  password_hash         TEXT NOT NULL,
  email                 TEXT,
  phone                 TEXT,
  role_id               INTEGER NOT NULL REFERENCES roles(id),
  status                TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'locked', 'suspended', 'disabled')),
  token_version         INTEGER NOT NULL DEFAULT 0,
  must_change_password  BOOLEAN NOT NULL DEFAULT false,
  mfa_required          BOOLEAN,
  failed_sign_in_count  INTEGER NOT NULL DEFAULT 0,
  locked_until          TIMESTAMPTZ,
  max_sessions          INTEGER,
  allowed_ips           TEXT[],
  locale                TEXT,
  timezone              TEXT,
  last_sign_in_at       TIMESTAMPTZ,
  password_changed_at   TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
