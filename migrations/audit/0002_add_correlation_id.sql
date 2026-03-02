ALTER TABLE audit_logs ADD COLUMN correlation_id UUID;

-- Partial index: excludes NULL rows (pre-correlation entries, standalone
-- system events) to reduce index size on a table that grows indefinitely.
CREATE INDEX idx_audit_logs_correlation_id
  ON audit_logs (correlation_id)
  WHERE correlation_id IS NOT NULL;
