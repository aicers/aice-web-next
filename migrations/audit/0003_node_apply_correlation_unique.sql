-- Phase Node-9c (#361) review round 3:
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
--
-- Idempotent: safe to re-run.

CREATE UNIQUE INDEX IF NOT EXISTS audit_logs_node_apply_correlation_unique
  ON audit_logs (correlation_id)
  WHERE action = 'node.apply' AND correlation_id IS NOT NULL;
