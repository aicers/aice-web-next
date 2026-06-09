-- Grant event:read to built-in roles that should see the Event
-- feature by default: Security Monitor, Tenant Administrator, and
-- System Administrator (#724). These are the same built-in roles that
-- receive detection:read (0019), since the Event menu browses the same
-- Giganto source data the Detection menu builds on.

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'event:read'
FROM roles r
WHERE r.name IN (
  'System Administrator',
  'Tenant Administrator',
  'Security Monitor'
)
ON CONFLICT DO NOTHING;
