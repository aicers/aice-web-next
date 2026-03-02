CREATE TABLE roles (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  description  TEXT,
  is_builtin   BOOLEAN NOT NULL DEFAULT false,
  mfa_required BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE role_permissions (
  role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
);

-- Seed built-in roles
INSERT INTO roles (name, description, is_builtin) VALUES
  ('System Administrator', 'Full system, account, role, customer management', true),
  ('Tenant Administrator', 'Tenant-scoped operations and Security Monitor account management', true),
  ('Security Monitor', 'Event and dashboard read-only within assigned customer', true);

-- System Administrator: all permissions (Discussion #32 §1.4)
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r,
LATERAL (VALUES
  ('accounts:read'), ('accounts:write'), ('accounts:delete'),
  ('roles:read'), ('roles:write'), ('roles:delete'),
  ('customers:read'), ('customers:write'), ('customers:access-all'),
  ('audit-logs:read'),
  ('system-settings:read'), ('system-settings:write')
) AS p(permission)
WHERE r.name = 'System Administrator';

-- Tenant Administrator: scoped account and customer permissions (Discussion #32 §1.4)
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r,
LATERAL (VALUES
  ('accounts:read'), ('accounts:write'), ('accounts:delete'),
  ('customers:read'), ('customers:write')
) AS p(permission)
WHERE r.name = 'Tenant Administrator';

-- Security Monitor: no account management permissions (Discussion #32 §1.4).
-- Data access permissions (events, dashboards) are defined separately.
