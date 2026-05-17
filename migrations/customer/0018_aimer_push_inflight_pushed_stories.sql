-- Add `pushed_stories` to `aimer_push_inflight` (sub-issue #493).
--
-- The opportunistic Story drain's new-row branch selects a slice of
-- `event_group` rows at mint time, signs it into the envelope, and
-- stores the cursor target on the inflight row. On ack, the β-bump +
-- `triage.story.send` audit must address the exact rows that were
-- actually included in the signed envelope — not whatever currently
-- matches the `(prev_cursor, new_cursor]` range.
--
-- Stories are ordered by `(time_window_end, id)`, which is event-window
-- ordering rather than creation-time ordering. A late-arriving
-- `auto_correlated` row whose `time_window_end` falls inside an
-- already-minted range would otherwise be β-bumped and audited at ack
-- without ever appearing in the pushed envelope, and the cursor would
-- advance past it so the drain would never re-send. Persisting the
-- exact id+version set at mint pins ack-time updates to the delivered
-- set, eliminating the race.
--
-- Each entry is `{ "story_id": "<numeric>", "story_version": "<text>" }`.
-- The column is `JSONB NOT NULL DEFAULT '[]'` so existing inflight rows
-- and non-story inflight kinds need no backfill.
--
-- Idempotent: re-applying against an already-migrated DB is a no-op.

ALTER TABLE aimer_push_inflight
  ADD COLUMN IF NOT EXISTS pushed_stories JSONB NOT NULL DEFAULT '[]'::jsonb;
