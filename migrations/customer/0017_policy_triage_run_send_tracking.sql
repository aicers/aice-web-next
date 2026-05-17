-- Phase 2 policy_run manual-Send tracking (sub-issue #572).
--
-- Two changes, shipped together so a finalize ack cannot arrive before
-- the β columns exist:
--
--   1. β columns on `policy_triage_run` mirroring the `event_group`
--      additions from #489. `last_sent_at` / `last_sent_by` are set in
--      the finalize transaction when a manual Send completes; the
--      Settings indicator ([#574]) renders "Last sent run: <run_id> at
--      <time>" + "Total runs sent: N" from these columns. The send is
--      always for one specific operator click, so `send_count` increments
--      by exactly one per successful Send action regardless of how many
--      multipart batches the run was split into.
--
--      `last_sent_by` references `auth_db.accounts(id)` (UUID). No FK is
--      added because cross-database foreign keys are not supported in
--      PostgreSQL — same pattern as `owner_account_id` on this table
--      and `last_sent_by` on `event_group`.
--
--   2. `aimer_policy_run_send_inflight` — a separate inflight table
--      from `aimer_push_inflight` because the policy-run Send lifecycle
--      is distinct: one operator action mints N batches sharing one
--      `send_action_id`, each batch has its own `context_jti`, and the
--      finalize route consumes the full set at once. Reusing
--      `aimer_push_inflight` would tangle these rows with the streaming
--      drain's `cursor_advance_to_event_time` / `queue_row_ids` columns
--      that are meaningless for a one-shot Send, and would force a
--      different TTL than the streaming kinds (`POLICY_RUN_SEND_INFLIGHT_TTL_SECONDS = 600`
--      vs `PHASE2_INFLIGHT_TTL_SECONDS = 120`).
--
-- Forward-only per `migrations/README.md`. The `IF NOT EXISTS` guards
-- keep this idempotent against accidental re-runs.

ALTER TABLE policy_triage_run
    ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_sent_by UUID,
    ADD COLUMN IF NOT EXISTS send_count   INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS aimer_policy_run_send_inflight (
    -- Mint-time JTI of the per-batch envelope. Primary key so a duplicate
    -- mint of the same JTI is rejected outright; pairs with the
    -- per-batch UNIQUE constraint below to defend the table against both
    -- shapes of duplicate-mint bugs.
    context_jti          TEXT        PRIMARY KEY,

    -- Operator-action correlator. Browser mints one UUID per Send click;
    -- every batch and the finalize call share the same value. The
    -- finalize route uses it (with `run_id` and `actor_account_id`) to
    -- locate the inflight rows for set-equality validation.
    send_action_id       UUID        NOT NULL,

    -- Cascades so deleting the source run cleans up any abandoned
    -- inflight rows (the TTL prune would catch them too, but cascade
    -- keeps cleanup synchronous when a run is hard-deleted).
    run_id               BIGINT      NOT NULL REFERENCES policy_triage_run(id) ON DELETE CASCADE,

    -- Session account that initiated the Send. Cross-DB so no FK; the
    -- finalize route cross-checks this against the session's effective
    -- account so a different operator cannot finalize someone else's
    -- Send even if they guess the `send_action_id`.
    actor_account_id     UUID        NOT NULL,

    -- Zero-based batch index within the Send. Used by finalize to map
    -- `batch_acks` entries back to the inflight rows and to detect a
    -- missing middle batch.
    batch_index          INTEGER     NOT NULL,

    -- True on the final batch of a Send (the one with `has_more = false`
    -- at build-envelope time). Finalize rejects when this row is missing
    -- from `batch_acks`, so a truncated multi-batch Send cannot quietly
    -- commit β / audit on a partial set.
    is_terminal          BOOLEAN     NOT NULL DEFAULT FALSE,

    -- Exclusive upper bound (`event_key`) of the slice this batch
    -- represents, captured at mint time so a retry of the same
    -- `send_action_id` can reproduce the same slice cursor. Null only
    -- for an empty-run Send (no events; one terminal batch with no
    -- slice).
    last_event_key       NUMERIC(39, 0),

    -- Exclusive lower bound (`event_key`) of the slice — the
    -- `after_event_key` cursor the build-envelope call was made with.
    -- Null on the first batch of a Send. Together with `send_action_id`
    -- this is the cursor identity of the batch; the partial unique
    -- indexes below catch a sequential retry of the same call (same
    -- send action, same cursor) so the route returns 409 instead of
    -- minting a duplicate batch with a fresh JTI.
    after_event_key      NUMERIC(39, 0),

    minted_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Catch duplicate-mint bugs at the DB level: one batch_index per
    -- send action. The build-envelope route translates the unique
    -- violation to a 409 Conflict with `duplicate_batch_for_send_action`.
    UNIQUE (send_action_id, batch_index)
);

CREATE INDEX IF NOT EXISTS idx_aimer_policy_run_send_inflight_action
    ON aimer_policy_run_send_inflight (send_action_id);
CREATE INDEX IF NOT EXISTS idx_aimer_policy_run_send_inflight_run
    ON aimer_policy_run_send_inflight (run_id, send_action_id);
CREATE INDEX IF NOT EXISTS idx_aimer_policy_run_send_inflight_ttl
    ON aimer_policy_run_send_inflight (minted_at);

-- Cursor-identity uniqueness. Split into two partial indexes so the
-- NULL-cursor first batch is also covered: PostgreSQL treats NULLs as
-- distinct in a plain UNIQUE constraint, which would allow two "first
-- batch" rows for the same send_action_id (the exact sequential-retry
-- bug we want to catch). Both indexes raise the same SQLSTATE 23505,
-- which the build-envelope route translates to
-- `duplicate_batch_for_send_action`.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_aimer_policy_run_send_inflight_cursor_notnull
    ON aimer_policy_run_send_inflight (send_action_id, after_event_key)
    WHERE after_event_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_aimer_policy_run_send_inflight_cursor_null
    ON aimer_policy_run_send_inflight (send_action_id)
    WHERE after_event_key IS NULL;
