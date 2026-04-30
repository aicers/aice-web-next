-- Cross-customer hardening (#387): persist the apply-attempt's owning
-- customer id on the row so the `node.apply` audit emission can populate
-- `audit_logs.customer_id`.
--
-- Background. The audit-log viewer (#386) scopes rows by
-- `audit_logs.customer_id IN (caller's effective customer scope)`. A
-- `node.apply` row written with `customer_id = NULL` is invisible to the
-- restricted operator who actually owns the customer that ran the
-- apply. The wrapper at `src/lib/node/apply-actions.ts` (synchronous
-- emission) and the recovery sweep at
-- `src/lib/node/apply-attempt-cleanup.ts:recoverPendingNodeApplyAudits`
-- (post-success backfill) both need to populate `customerId`, but
-- neither code path holds the customer id directly — only the canonical
-- node read inside `createApplyAttempt` does.
--
-- Persisting the customer id on the attempt row at creation time lets
-- both emitters read it back without re-reading the manager DB. The
-- column is NULL-able because a globally-scoped caller may create an
-- attempt against a node that carries no `customerId` on either profile
-- — `enforceNodeScope` already permits that path. For those rows the
-- audit emission stays `customer_id = NULL`, which matches the
-- semantics: there is no owning customer to scope against.
--
-- Idempotent: safe to re-run.

ALTER TABLE apply_attempts
  ADD COLUMN IF NOT EXISTS customer_id INTEGER;
