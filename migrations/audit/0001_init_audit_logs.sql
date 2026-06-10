-- audit_db v1 initial schema.
--
-- The pre-release migration history (0001-0003) was squashed into this
-- single file before the first release.

CREATE TABLE audit_logs (
  id             BIGSERIAL PRIMARY KEY,
  timestamp      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_id       TEXT NOT NULL,
  action         TEXT NOT NULL,
  target_type    TEXT NOT NULL,
  target_id      TEXT,
  details        JSONB,
  ip_address     TEXT,
  sid            TEXT,
  customer_id    INTEGER,
  -- Groups related entries written by one logical operation (e.g. a
  -- bulk apply). NULL for standalone system events.
  correlation_id UUID
);

CREATE INDEX idx_audit_logs_timestamp ON audit_logs (timestamp);
CREATE INDEX idx_audit_logs_actor_id ON audit_logs (actor_id);
CREATE INDEX idx_audit_logs_action ON audit_logs (action);

-- Partial index serving the audit API's correlation filter: excludes
-- NULL rows (standalone system events) to reduce index size on a
-- table that grows indefinitely.
CREATE INDEX idx_audit_logs_correlation_id
  ON audit_logs (correlation_id)
  WHERE correlation_id IS NOT NULL;

-- Phase Node-9c (#361):
--
-- Make `node.apply` audit emission idempotent at the database layer so
-- the umbrella's "exactly once per attempt that reaches succeeded"
-- contract is enforced by the schema, not just by the wrapper's
-- two-step persisted slot. Without this guard, a process death between
-- a successful audit insert and `markNodeApplyAuditCompleted` (or
-- between the wrapper's catch path and the cleanup-sweep recovery)
-- would let the recovery sweep re-emit the audit and produce a
-- duplicate row.
--
-- The bulk-apply wrapper and the cleanup-sweep recovery both pass the
-- attempt UUID as `correlation_id` on `node.apply` audit rows, so a
-- partial unique index on `(correlation_id) WHERE action = 'node.apply'
-- AND correlation_id IS NOT NULL` is the smallest, lowest-risk
-- guarantee that satisfies "exactly once" without affecting any other
-- audit action. Other actions retain their existing dedupe semantics
-- (none) — the partial predicate restricts uniqueness to the rows
-- where the umbrella requires it.
CREATE UNIQUE INDEX audit_logs_node_apply_correlation_unique
  ON audit_logs (correlation_id)
  WHERE action = 'node.apply' AND correlation_id IS NOT NULL;

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
