-- This script runs on first volume init via docker-entrypoint-initdb.d, but
-- is also intentionally safe to run by hand against an existing cluster
-- (e.g. `psql -U postgres -f init-audit-db.sql`). Every statement is
-- guarded so re-runs are no-ops, not errors, which avoids the
-- `docker volume rm <project>_pgdata` recovery dance when an operator
-- needs to re-apply provisioning.

-- CREATE DATABASE cannot run inside DO blocks; use the `\gexec` pattern
-- to skip when audit_db already exists.
SELECT 'CREATE DATABASE audit_db'
WHERE NOT EXISTS (
  SELECT FROM pg_database WHERE datname = 'audit_db'
)\gexec

-- The audit_writer role has INSERT/SELECT only on audit_logs (granted by
-- migration 0001_init_audit_logs.sql after the table is created, and
-- re-applied at boot by ensureAuditRolePermissions in
-- src/lib/db/migrate.ts). Password should be overridden via
-- POSTGRES_INITDB_ARGS or changed after provisioning for production
-- deployments.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_writer') THEN
    CREATE ROLE audit_writer WITH LOGIN PASSWORD 'changeme';
  END IF;
END $$;

-- PostgreSQL 15+ revokes CREATE on the public schema from PUBLIC by
-- default.  The application runs migrations (CREATE TABLE) as
-- audit_writer, so it needs CREATE + USAGE on the public schema.
\c audit_db
GRANT CREATE, USAGE ON SCHEMA public TO audit_writer;
