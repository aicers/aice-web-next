-- Phase 2 ingestion foundation: per-customer push state, durable queue,
-- and inflight ack tracker. Sub-issue #591 of #570.
--
-- All three tables live in the per-customer DB. The database itself is
-- the customer scope, so no `customer_id` column.
--
-- Idempotent (`IF NOT EXISTS` on tables, `ON CONFLICT DO NOTHING` on the
-- seed) so a second application against an already-migrated DB is a
-- no-op. The customer-migration runner is forward-only.

-- Cursor + per-kind sync state + pause toggle.
-- One row per streaming push kind. `policy_run` is intentionally
-- excluded (manual-only, β columns on `policy_triage_run`); `policy_event`
-- is also excluded (queue-only, no cursor).
CREATE TABLE IF NOT EXISTS aimer_push_state (
  kind                    TEXT        PRIMARY KEY
                          CHECK (kind IN ('baseline_event', 'story')),
  -- cursor
  last_pushed_event_time  TIMESTAMPTZ,
  last_pushed_event_key   TEXT,
  -- liveness / failure state
  last_synced_at          TIMESTAMPTZ,
  last_error              TEXT,
  -- pause toggle
  opportunistic_enabled   BOOLEAN     NOT NULL DEFAULT TRUE,
  paused_at               TIMESTAMPTZ,
  paused_by               UUID                                  -- account_id; cross-DB so no FK
);

-- Seed one row per streaming kind. Initial cursor is "now" (NULL until
-- the first opportunistic push writes `last_pushed_event_time`).
INSERT INTO aimer_push_state (kind)
VALUES ('baseline_event'), ('story')
ON CONFLICT (kind) DO NOTHING;

-- Withdraw / refresh / backfill notices waiting to be delivered.
-- The `kind` discriminator maps 1:1 to one aimer-web endpoint + one
-- schema_version so a drain route does not need to inspect payload to
-- pick the destination.
CREATE TABLE IF NOT EXISTS aimer_push_queue (
  id                  BIGSERIAL    PRIMARY KEY,
  enqueued_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  kind                TEXT         NOT NULL
                      CHECK (kind IN (
                        'withdraw_baseline_event',
                        'withdraw_story',
                        'withdraw_policy_event',
                        'refresh_baseline_window',
                        'refresh_story_window',
                        'backfill_baseline_window',
                        'backfill_story_window'
                      )),
  payload             JSONB        NOT NULL,
  attempts            INTEGER      NOT NULL DEFAULT 0,
  last_attempt_at     TIMESTAMPTZ,
  last_error          TEXT,
  acked_at            TIMESTAMPTZ,
  acked_context_jti   TEXT
);

CREATE INDEX IF NOT EXISTS idx_aimer_push_queue_pending
  ON aimer_push_queue (id)
  WHERE acked_at IS NULL;

-- In-flight ack tracker for the browser-driven drain loop. One row per
-- envelope minted by a `next-batch` route that has been sent to the
-- browser but not yet ack'd via the next call's `acked_context_jti`.
-- TTL-pruned (~2 min) by the `next-batch` route on each call.
CREATE TABLE IF NOT EXISTS aimer_push_inflight (
  context_jti                   TEXT         PRIMARY KEY,
  kind                          TEXT         NOT NULL
                                CHECK (kind IN ('baseline_event', 'story', 'policy_event')),
  minted_at                     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  cursor_advance_to_event_time  TIMESTAMPTZ,  -- streaming kinds only; NULL for policy_event
  cursor_advance_to_event_key   TEXT,         -- streaming kinds only; NULL for policy_event
  queue_row_ids                 BIGINT[]     NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_aimer_push_inflight_ttl
  ON aimer_push_inflight (minted_at);
