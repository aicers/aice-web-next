-- Baseline algorithm PR 2: schema contract for §9 (RFC 0001).
--
-- Completes the expand/contract pattern that 0005 / 0006 started:
-- backfills `raw_score` and `selector_tags` for any rows that pre-date
-- the PR 1 dual-write deploy, then tightens both columns to NOT NULL
-- so future readers (and the read-time `cume_dist()` over `raw_score`
-- from §3) can rely on the values being present.
--
-- Order of operations is load-bearing:
--   1. The preflight `DO` block aborts before any UPDATE if a Phase 1.A
--      row sits on disk with `baseline_score IS NULL`. PR 1 / #481's
--      additive score is always in `{0.5, 1.0, 1.5}`, so any NULL
--      `baseline_score` is anomalous and indicates either a manual
--      INSERT or a writer running against the wrong code path; the
--      migration refuses to silently fold those rows to `raw_score = 0`
--      via `COALESCE` because it would mask the producer's bug. The
--      operator's recovery path is to investigate the offending rows
--      and either re-score them or delete them, then re-run the
--      migration.
--   2. `selector_tags = '{}'` backfill catches pre-Phase-1.A rows that
--      predate #481's tag emission. 0005 set `DEFAULT '{}'` for future
--      INSERTs; the UPDATE here is what makes the column safe to
--      tighten.
--   3. `raw_score = baseline_score` backfill catches rows produced
--      before PR 1's dual-write deploy. Rows produced after PR 1
--      already carry the dual-write value, so the WHERE on
--      `raw_score IS NULL` makes this a no-op for them. The
--      semantic claim is only that the value is non-null and within
--      each row's own `baseline_version` — `cume_dist()` re-ranks
--      per `(kind, baseline_version)` cohort, so a Phase 1.A row's
--      backfilled `raw_score` is never compared to a Phase 1.B row's
--      `raw_score`.
--   4. `SET NOT NULL` on both columns. Brief `ACCESS EXCLUSIVE` lock;
--      run during the cadence's idle gap or pause the per-customer
--      scheduler tick. Pre-merge gate: PR 1 (#512) must be rolled out
--      across all cadence replicas before this migration runs so no
--      old replica can INSERT a NULL `raw_score` between the UPDATE
--      and the `SET NOT NULL`.

DO $$
DECLARE
    null_count BIGINT;
BEGIN
    SELECT count(*) INTO null_count
      FROM baseline_triaged_event
     WHERE baseline_score IS NULL
       AND raw_score IS NULL;
    IF null_count > 0 THEN
        RAISE EXCEPTION
            'baseline migration preflight: % rows have both baseline_score AND raw_score NULL — refusing to backfill raw_score=0 by default (RFC 0001 §9 backfill contract). Investigate and re-run.',
            null_count;
    END IF;
END $$;

UPDATE baseline_triaged_event
   SET selector_tags = '{}'
 WHERE selector_tags IS NULL;

UPDATE baseline_triaged_event
   SET raw_score = baseline_score
 WHERE raw_score IS NULL;

ALTER TABLE baseline_triaged_event
    ALTER COLUMN selector_tags SET NOT NULL;

ALTER TABLE baseline_triaged_event
    ALTER COLUMN raw_score SET NOT NULL;
