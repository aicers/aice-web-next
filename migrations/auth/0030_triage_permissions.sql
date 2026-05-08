-- Seed Triage permissions onto the three built-in roles per the design
-- in discussion #447 §5 (Phase 1.A). Phase 1.A only enforces
-- `triage:read` (it gates the menu); the three `triage:*:write`
-- permissions are placeholders that 1B-2 / 1B-5 will start enforcing,
-- but admins can pre-grant/revoke them now.
--
-- Each permission is its own INSERT to honor the deprecatability seam
-- (§6 of #447): future deprecation of `triage:policy:write` removes
-- exactly one row without disturbing the other three.
--
-- Idempotent: safe to re-run (#454).

-- triage:read → System Administrator + Tenant Administrator + Security Monitor
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'triage:read'
FROM roles r
WHERE r.name IN (
  'System Administrator',
  'Tenant Administrator',
  'Security Monitor'
)
ON CONFLICT DO NOTHING;

-- triage:policy:write → System Administrator + Tenant Administrator
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'triage:policy:write'
FROM roles r
WHERE r.name IN (
  'System Administrator',
  'Tenant Administrator'
)
ON CONFLICT DO NOTHING;

-- triage:exclusion:write → System Administrator + Tenant Administrator
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'triage:exclusion:write'
FROM roles r
WHERE r.name IN (
  'System Administrator',
  'Tenant Administrator'
)
ON CONFLICT DO NOTHING;

-- triage:exclusion:global:write → System Administrator only
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'triage:exclusion:global:write'
FROM roles r
WHERE r.name = 'System Administrator'
ON CONFLICT DO NOTHING;
