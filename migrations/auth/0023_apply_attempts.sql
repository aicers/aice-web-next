-- Phase Node-9a (#359): server-side ApplyAttempt table backing the
-- bulk-apply lifecycle / state machine / TTL / recovery surface.
--
-- One row per in-flight or recently-finished apply plan, holding its
-- frozen plan (`planned_dispatches`), the draft fingerprint over the
-- manager-DB draft state at plan-build time, and the lifecycle status
-- + lock + execution-deadline / retention-deadline.
--
-- Per the umbrella (#306, #314): orchestration metadata, NOT a replica
-- of manager-DB drafts. Drafts continue to live in the manager DB and
-- are read fresh on every plan build / pre-dispatch recompute.
--
-- TTL contract (configurable via env, see .env.example):
--   APPLY_ATTEMPT_TTL_MS      - non-terminal execution deadline (default 30 min)
--   APPLY_ATTEMPT_RETENTION_MS - terminal retention (default 7 days)
--   APPLY_EXECUTING_STALE_MS  - stale-lock recovery threshold (default 2.5 hours)
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS apply_attempts (
  attempt_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id             TEXT NOT NULL,
  draft_fingerprint   BYTEA NOT NULL,
  planned_dispatches  JSONB NOT NULL,
  created_by          UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ NOT NULL,
  executing_lock      UUID,
  claim_started_at    TIMESTAMPTZ,
  status              TEXT NOT NULL
                      CHECK (status IN (
                        'pending',
                        'executing',
                        'succeeded',
                        'failed_retryable',
                        'failed_terminal',
                        'stale',
                        'expired'
                      ))
);

CREATE INDEX IF NOT EXISTS apply_attempts_created_by_idx
  ON apply_attempts (created_by);

CREATE INDEX IF NOT EXISTS apply_attempts_expires_at_idx
  ON apply_attempts (expires_at);

CREATE INDEX IF NOT EXISTS apply_attempts_node_id_status_idx
  ON apply_attempts (node_id, status);

-- Partial index covering only rows currently holding an executing
-- lock. Drives the stale-lock recovery sweep without scanning rows
-- that aren't candidates.
CREATE INDEX IF NOT EXISTS apply_attempts_claim_started_at_idx
  ON apply_attempts (claim_started_at)
  WHERE executing_lock IS NOT NULL;
