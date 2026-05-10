-- Durable fanout queue for global triage-exclusion ADDs (1B-2).
--
-- A global ADD must apply retroactively across every active
-- customer's tenant DB. Doing this synchronously inside the HTTP
-- request risks request timeouts and partial-success ambiguity, so
-- the request enqueues one job row per active customer here and an
-- internal scheduled route (`POST /api/internal/triage/exclusion/fanout`)
-- claims rows with `FOR UPDATE SKIP LOCKED`, runs the per-customer
-- DELETE under the per-customer advisory lock, and finalizes the row.
--
-- Lives in `auth_db` because the global exclusion FK target is here.
-- Tenant DBs do not need to know about the queue.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS triage_exclusion_fanout_job (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The global exclusion this job is fanning out. ON DELETE CASCADE:
    -- if the global row is removed before its fanout completes, the
    -- pending jobs cascade away (retroactive DELETE is moot).
    global_exclusion_id  UUID NOT NULL
                           REFERENCES global_triage_exclusion(id) ON DELETE CASCADE,
    customer_id          INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    status               TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    attempt_count        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Set when a worker claims the row (status -> 'running'). Used by
    -- the stuck-job sweep to return rows whose worker died mid-run.
    claimed_at           TIMESTAMPTZ,
    last_error           TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS triage_exclusion_fanout_job_pending_idx
    ON triage_exclusion_fanout_job (next_attempt_at)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS triage_exclusion_fanout_job_running_idx
    ON triage_exclusion_fanout_job (claimed_at)
    WHERE status = 'running';
