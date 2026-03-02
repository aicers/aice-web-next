CREATE TABLE audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_id    TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT,
  details     JSONB,
  ip_address  TEXT,
  sid         TEXT,
  customer_id INTEGER
);

CREATE INDEX idx_audit_logs_timestamp ON audit_logs (timestamp);
CREATE INDEX idx_audit_logs_actor_id ON audit_logs (actor_id);
CREATE INDEX idx_audit_logs_action ON audit_logs (action);

-- Grant INSERT/SELECT only to audit_writer role for tamper resistance
-- (Discussion #46 §2). The role is created during database provisioning
-- (see infra/postgres/init-audit-db.sql). If the role does not exist
-- (e.g., non-Docker environment), grants are skipped.
DO $$ BEGIN
  EXECUTE 'GRANT USAGE ON SCHEMA public TO audit_writer';
  EXECUTE 'GRANT SELECT, INSERT ON TABLE audit_logs TO audit_writer';
  EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE audit_logs_id_seq TO audit_writer';
EXCEPTION WHEN undefined_object THEN
  RAISE NOTICE 'Role audit_writer does not exist. Skipping grants.';
END $$;
