-- Story streaming late-commit backfill anchor (sub-issue #493 round-5
-- follow-up).
--
-- The Phase 2 story drain (`POST /api/aimer/phase2/story/next-batch`)
-- advances a `(created_at, id)` cursor on `aimer_push_state`. Because
-- `event_group.created_at` defaults to `now()` (= transaction-START
-- time in PostgreSQL, not insert-statement / commit time), a correlator
-- transaction that begins before a drain reads can commit AFTER the
-- drain advances the cursor while persisting a row whose `created_at`
-- is BEHIND the just-advanced cursor. Without a recovery path that row
-- would have `last_sent_at IS NULL` permanently — never re-selected by
-- the forward `(created_at, id) > cursor` slice. See the module
-- comment on `src/lib/aimer/phase2/story-push.ts` for the full
-- rationale.
--
-- The recovery path is a "straggler" scan: each drain call additionally
-- queries `WHERE last_sent_at IS NULL AND created_at <= cursor` and
-- emits any hits as a streaming push WITHOUT advancing the cursor (β /
-- audit address the persisted `pushed_stories` set, the cursor stays
-- put). To prevent that scan from back-flooding the entire historical
-- `event_group` corpus on a freshly-seeded tenant — the issue's
-- "no historical back-flood on first activation" requirement — the
-- scan is anchored to a per-state activation watermark stored in this
-- new column.
--
--   - `seedNullCursor` (the first `next-batch` call with no queue work)
--     sets `streaming_activated_at = NOW()` alongside the cursor seed.
--     Rows whose `created_at < streaming_activated_at` are pre-
--     activation history and stay invisible to the straggler scan
--     forever.
--   - Rows committed AFTER activation but with `created_at < cursor`
--     (the race target — long correlator transactions) are caught by
--     the straggler scan and delivered automatically.
--
-- Backfill for already-migrated tenants: any state row whose cursor is
-- already seeded inherits `streaming_activated_at = last_pushed_event_time`
-- so historical back-flood is still suppressed without re-prompting
-- another seed. Unseeded rows are left NULL (a NULL means "never
-- activated, do not run the straggler scan yet" — the next call's
-- `seedNullCursor` populates both columns atomically).
--
-- Idempotent: `ADD COLUMN IF NOT EXISTS`. The `UPDATE` is a no-op when
-- the column is already populated (re-run leaves all values intact).

ALTER TABLE aimer_push_state
  ADD COLUMN IF NOT EXISTS streaming_activated_at TIMESTAMPTZ;

UPDATE aimer_push_state
   SET streaming_activated_at = last_pushed_event_time
 WHERE streaming_activated_at IS NULL
   AND last_pushed_event_time IS NOT NULL;
