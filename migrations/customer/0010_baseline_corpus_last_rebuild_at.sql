-- Triage baseline rebuild (#473): admin-driven force-rebuild path.
--
-- Adds a single nullable column to `baseline_corpus_state` so the
-- `POST /api/triage/baseline/rebuild` handler can record the wall-clock
-- moment of the most recent rebuild. The cadence runner does NOT touch
-- this column — it remains a side-channel marker exclusive to the
-- admin rebuild path. NULL means "never rebuilt"; once set, the value
-- is overwritten on every successful rebuild.

ALTER TABLE baseline_corpus_state
    ADD COLUMN IF NOT EXISTS last_rebuild_at TIMESTAMPTZ;
