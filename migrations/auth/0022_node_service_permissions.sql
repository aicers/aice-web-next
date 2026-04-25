-- Add the node and service management permission strings and grant them to
-- the three built-in roles per `decisions/node-permissions.md`. Refreshes
-- the Tenant Administrator and Security Monitor descriptions so fresh
-- installs and upgraded installs both reflect the new responsibilities.
-- Idempotent: safe to re-run (#307).

-- System Administrator: all five node/service permissions, unrestricted.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r,
LATERAL (VALUES
  ('nodes:read'),
  ('nodes:write'),
  ('nodes:delete'),
  ('services:read'),
  ('services:write')
) AS p(permission)
WHERE r.name = 'System Administrator'
ON CONFLICT DO NOTHING;

-- Tenant Administrator: all five permissions, scoped to assigned customers
-- via the existing customer-scope helpers.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r,
LATERAL (VALUES
  ('nodes:read'),
  ('nodes:write'),
  ('nodes:delete'),
  ('services:read'),
  ('services:write')
) AS p(permission)
WHERE r.name = 'Tenant Administrator'
ON CONFLICT DO NOTHING;

-- Security Monitor: read-only nodes/services within assigned customers.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r,
LATERAL (VALUES
  ('nodes:read'),
  ('services:read')
) AS p(permission)
WHERE r.name = 'Security Monitor'
ON CONFLICT DO NOTHING;

-- Refresh Tenant Administrator description: append node/service clause to
-- the existing wording.
UPDATE roles
SET description = 'Tenant-scoped operations and Security Monitor account management, node and service management within assigned customers',
    updated_at = NOW()
WHERE name = 'Tenant Administrator'
  AND is_builtin = true;

-- Refresh Security Monitor description: append node/service read-only clause
-- to the existing wording (which already covers detection per #272).
UPDATE roles
SET description = 'Read-only event, dashboard, and detection access within assigned customers, node and service status read-only within assigned customer',
    updated_at = NOW()
WHERE name = 'Security Monitor'
  AND is_builtin = true;
