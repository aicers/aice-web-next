INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'customers:delete'
FROM roles r
WHERE r.name = 'System Administrator';
