-- Now that Security Monitor has detection:read in addition to the
-- existing read-only event/dashboard scope (#272), refresh the built-in
-- role description so fresh installs and upgraded installs show copy
-- that matches the granted permissions.

UPDATE roles
SET description = 'Read-only event, dashboard, and detection access within assigned customers',
    updated_at = NOW()
WHERE name = 'Security Monitor'
  AND is_builtin = true;
