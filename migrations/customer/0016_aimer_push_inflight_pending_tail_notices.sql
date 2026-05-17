-- Add `pending_tail_notices` to `aimer_push_inflight` (sub-issue #571).
--
-- When a drain route subdivides a queue payload at push time — e.g. the
-- baseline-event refresh/backfill enrichment path, where the §6
-- enrichment fields (`raw_event`, `score_window_context`, ...) added at
-- drain time can push the previously-fitted sub-window past the shared
-- byte cap — the head sub-payload is delivered this round and the tail
-- sub-payloads must wait for the head's ack before re-entering the queue.
--
-- Recording the tail sub-payloads on the inflight row keeps them out of
-- `aimer_push_queue` until ack-time, so a failed POST cleanly drops
-- them with the inflight delete (in `recordOnFail`) and the next retry
-- redoes the subdivision freshly — no duplicate tail rows accumulating
-- across retries.
--
-- Each entry is `{ "kind": "<queue_kind>", "payload": <jsonb> }`. The
-- column is `JSONB NOT NULL DEFAULT '[]'` so existing inflight rows
-- (and drain routes that don't subdivide) need no migration backfill.
--
-- Idempotent: re-applying against an already-migrated DB is a no-op.

ALTER TABLE aimer_push_inflight
  ADD COLUMN IF NOT EXISTS pending_tail_notices JSONB NOT NULL DEFAULT '[]'::jsonb;
