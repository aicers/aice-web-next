-- This script runs once when the PostgreSQL volume is first initialized
-- (via docker-entrypoint-initdb.d). It creates the audit_db database
-- and the restricted audit_writer role used by the application at runtime.

CREATE DATABASE audit_db;

-- The audit_writer role has INSERT/SELECT only on audit_logs (granted by
-- migration 0001_init_audit_logs.sql after the table is created).
-- Password should be overridden via POSTGRES_INITDB_ARGS or changed
-- after provisioning for production deployments.
CREATE ROLE audit_writer WITH LOGIN PASSWORD 'changeme';
