-- Add dashboard:read and dashboard:write permissions to System Administrator.
-- Separates "can view/modify system settings" from "can view/act on admin dashboard"
-- so that custom roles with system-settings:read do not gain dashboard access (#135).

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r,
LATERAL (VALUES
  ('dashboard:read'),
  ('dashboard:write')
) AS p(permission)
WHERE r.name = 'System Administrator'
ON CONFLICT DO NOTHING;
