-- Phase Node-9c (#361): once-only `node.apply` audit emission guard.
--
-- The audit-once contract from the umbrella requires that an attempt
-- which reaches `succeeded` emit `node.apply` exactly once, regardless
-- of how many `confirmApplyAttempt` / `retryDispatch` calls it took
-- (and regardless of concurrent calls racing on the same `attemptId`).
--
-- The lifecycle module's atomic claim already serialises the call
-- that flips the row to `succeeded`, but the loser of a concurrent
-- claim falls through `resolveLostClaim()` and returns the persisted
-- `succeeded` row to its caller, so a wrapper-level pre-status read is
-- not sufficient to guarantee single emission. This column lets the
-- wrapper test-and-set an audit-emission slot in a single guarded
-- UPDATE: the first caller to flip `NULL → NOW()` emits the audit,
-- every other caller observes a non-zero `succeeded_audit_emitted_at`
-- and skips emission.
--
-- NULL means "no audit has been emitted for this attempt yet". The
-- column stays NULL for non-`succeeded` terminal states (`stale`,
-- `expired`, `failed_terminal`) — only `node.apply` on `succeeded`
-- uses the slot.
--
-- Idempotent: safe to re-run.

ALTER TABLE apply_attempts
  ADD COLUMN IF NOT EXISTS succeeded_audit_emitted_at TIMESTAMPTZ;
