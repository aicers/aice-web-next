-- Grant detection:read to built-in roles that should see the Detection
-- feature by default: Security Monitor, Tenant Administrator, and
-- System Administrator (#272).

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'detection:read'
FROM roles r
WHERE r.name IN (
  'System Administrator',
  'Tenant Administrator',
  'Security Monitor'
)
ON CONFLICT DO NOTHING;
