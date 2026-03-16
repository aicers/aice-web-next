UPDATE system_settings
SET value = value - 'periodic_change_enabled' - 'periodic_change_days',
    updated_at = NOW()
WHERE key = 'password_policy';

UPDATE system_settings
SET value = value - 'stage2_threshold',
    updated_at = NOW()
WHERE key = 'lockout_policy';
