// Representative-profile assertion for the Phase 1.B menu read-path
// measurement harness (issue #524 §2).
//
// The harness's contract with #528 is "every measurement run reflects
// production-shaped data." A tenant DB that does not meet the profile
// — too few rows, a degenerate single-partition `cume_dist()` pass, a
// stale corpus — would produce timings that #528 cannot generalize.
// The harness therefore refuses to run against such a DB and exits
// with a clear, copy-pasteable error.
//
// Thresholds live here (next to the SQL that probes them) so updating
// one without the other is a single-file change. The harness header
// references this module; keep them in sync if the threshold values
// change.
//
// Story-shape checks (issue #601) live alongside the menu-shape ones
// — the cadence's slop-replay measurement requires both
// `story_finalized_through IS NOT NULL` and a non-trivial R3 phase-1
// candidate count over the actual slop-replay scan range the harness
// will probe. The assertion therefore takes a structured second
// argument carrying `nowMs` plus the slop-replay member-scan range,
// so it can run the same phase-1 SQL the harness measures and refuse
// to certify a tenant that returns too few assets.

import { CRITICAL_SELECTOR_SET } from "../../src/lib/triage/story/critical-sets.mjs";
import { buildReadR3CandidatesPhase1Sql } from "../../src/lib/triage/story/read-path-sql.mjs";

const CRITICAL_SELECTOR_ARRAY = Array.from(CRITICAL_SELECTOR_SET);

export const PROFILE_THRESHOLDS = {
  baselineTriagedEventMinRows: 200_000,
  observedEventMetaMinRows: 1_000_000,
  minDistinctKindVersionPartitions: 4,
  minDistinctOrigAddr: 500,
  baselineEventTimeMinSpanMs: 30 * 24 * 60 * 60 * 1000,
  observedEventTimeMinSpanMs: 30 * 24 * 60 * 60 * 1000,
  maxCorpusStalenessMs: 2 * 60 * 60 * 1000,
  // The "recent 30 days are covered" check (issue #524 §2) needs a
  // staleness bound on the high-water mark — a corpus whose newest
  // row is months old can technically have a 30-day-wide span but
  // is not representative of the window the harness measures. We
  // reuse the corpus-state staleness threshold (2h) so both checks
  // tell operators the same story: production-shaped ingest is
  // current.
  maxEventTimeStalenessMs: 2 * 60 * 60 * 1000,
  // Issue #601 Story-shape additions. A non-NULL
  // `story_finalized_through` proves the cadence has finalized at
  // least one tick — without that, the slop-replay scan range is
  // undefined and the gate's purpose is defeated. The phase-1
  // candidate-asset floor is over the *slop-replay* scan range only;
  // first-tick's `memberScanStart === null` scan covers the full
  // table, so a high candidate count there is a weak pass signal.
  // The starting threshold is conservative (≥ 5) and can be raised
  // once the gate measurement reports concrete numbers.
  minSlopReplayPhase1Candidates: 5,
};

/**
 * Probe SQL used by `assertRepresentativeProfile`. Co-located here so a
 * test can exercise the assertion against fixture rows without touching
 * a real DB — the test stubs `pool.query` and the assertion's call
 * sites map 1:1 onto these names.
 */
export const PROFILE_PROBE_SQL = {
  baselineRowCount: `SELECT COUNT(*)::text AS count FROM baseline_triaged_event`,
  observedRowCount: `SELECT COUNT(*)::text AS count FROM observed_event_meta`,
  distinctPartitions: `SELECT COUNT(*)::text AS count
                        FROM (
                          SELECT DISTINCT kind, baseline_version
                            FROM baseline_triaged_event
                        ) t`,
  distinctOrigAddr: `SELECT COUNT(DISTINCT orig_addr)::text AS count
                       FROM baseline_triaged_event
                      WHERE orig_addr IS NOT NULL`,
  baselineEventTimeSpan: `SELECT MIN(event_time) AS lo, MAX(event_time) AS hi
                            FROM baseline_triaged_event`,
  observedEventTimeSpan: `SELECT MIN(event_time) AS lo, MAX(event_time) AS hi
                            FROM observed_event_meta`,
  corpusState: `SELECT last_ingested_at, last_run_status
                  FROM baseline_corpus_state
                 WHERE id = true`,
  storyFinalizedThrough: `SELECT story_finalized_through
                            FROM baseline_corpus_state
                           WHERE id = true`,
};

/**
 * SQL the slop-replay candidate-asset count assertion runs. Shares
 * the R3 phase-1 builder with both the cadence (`story/repository.ts`)
 * and the harness (`MEASURED_QUERIES`) so any future change to the
 * pre-aggregation shape lands in one place. The harness threads in
 * `slopReplayPhase1Sql` as the `phase-1 over the slop-replay scan
 * range` count rather than re-deriving it here.
 */
export const PROFILE_SLOP_REPLAY_PHASE1_SQL = buildReadR3CandidatesPhase1Sql({
  memberScanStartIsNull: false,
});

export class ProfileAssertionError extends Error {
  /**
   * @param {Array<{ check: string, detail: string }>} failures
   */
  constructor(failures) {
    super(
      `representative-profile assertion failed (${failures.length} check(s))`,
    );
    this.name = "ProfileAssertionError";
    this.failures = failures;
  }
}

/**
 * Run every profile probe against the given pool and throw
 * `ProfileAssertionError` if any threshold is unmet. The function
 * returns the raw probe results on success so a caller can log them
 * alongside the run.
 *
 * Second argument is structured per issue #601: `nowMs` for time-
 * based assertions, plus a `memberScan` range the slop-replay
 * phase-1 candidate-asset count assertion needs. The harness passes
 * the same range the cadence's `runStepF` would use, so the
 * assertion measures the same scan that the gate's measurement will
 * exercise — a count against the full table would be a weak pass
 * signal (the first-tick scan covers the full table by construction;
 * the gate cares about slop-replay).
 *
 * Backwards-compatible bare-number form: passing a bare `nowMs`
 * number (legacy callers) skips the Story-shape checks but still
 * runs the menu-shape ones. New callers should pass the structured
 * form so the gate-required checks fire.
 *
 * @param {object} pool
 * @param {number | { nowMs?: number, memberScan?: { startIso: string | null, endIso: string } }} [opts]
 */
export async function assertRepresentativeProfile(pool, opts) {
  const { nowMs, memberScan } = normalizeAssertOpts(opts);
  const failures = [];
  const results = {};

  const baselineCount = await scalarCount(
    pool,
    PROFILE_PROBE_SQL.baselineRowCount,
  );
  results.baselineRowCount = baselineCount;
  if (baselineCount < PROFILE_THRESHOLDS.baselineTriagedEventMinRows) {
    failures.push({
      check: "baselineRowCount",
      detail:
        `baseline_triaged_event has ${baselineCount.toLocaleString()} rows; ` +
        `representative profile requires ≥ ${PROFILE_THRESHOLDS.baselineTriagedEventMinRows.toLocaleString()}`,
    });
  }

  const observedCount = await scalarCount(
    pool,
    PROFILE_PROBE_SQL.observedRowCount,
  );
  results.observedRowCount = observedCount;
  if (observedCount < PROFILE_THRESHOLDS.observedEventMetaMinRows) {
    failures.push({
      check: "observedRowCount",
      detail:
        `observed_event_meta has ${observedCount.toLocaleString()} rows; ` +
        `representative profile requires ≥ ${PROFILE_THRESHOLDS.observedEventMetaMinRows.toLocaleString()}`,
    });
  }

  const partitions = await scalarCount(
    pool,
    PROFILE_PROBE_SQL.distinctPartitions,
  );
  results.distinctPartitions = partitions;
  if (partitions < PROFILE_THRESHOLDS.minDistinctKindVersionPartitions) {
    failures.push({
      check: "distinctPartitions",
      detail:
        `baseline_triaged_event has ${partitions} distinct (kind, baseline_version) ` +
        `partition(s); profile requires ≥ ${PROFILE_THRESHOLDS.minDistinctKindVersionPartitions} ` +
        "so `cume_dist() OVER (PARTITION BY ...)` exercises real partitioning",
    });
  }

  const distinctOrigAddr = await scalarCount(
    pool,
    PROFILE_PROBE_SQL.distinctOrigAddr,
  );
  results.distinctOrigAddr = distinctOrigAddr;
  if (distinctOrigAddr < PROFILE_THRESHOLDS.minDistinctOrigAddr) {
    failures.push({
      check: "distinctOrigAddr",
      detail:
        `baseline_triaged_event has ${distinctOrigAddr.toLocaleString()} distinct ` +
        `orig_addr value(s); profile requires ≥ ${PROFILE_THRESHOLDS.minDistinctOrigAddr.toLocaleString()}`,
    });
  }

  const baselineSpan = await spanQuery(
    pool,
    PROFILE_PROBE_SQL.baselineEventTimeSpan,
    nowMs,
  );
  results.baselineEventTimeSpan = baselineSpan;
  appendSpanFailures(failures, "baseline", baselineSpan, {
    minRecentMs: PROFILE_THRESHOLDS.baselineEventTimeMinSpanMs,
    maxStalenessMs: PROFILE_THRESHOLDS.maxEventTimeStalenessMs,
    tableLabel: "baseline_triaged_event",
    requirementLabel: "the most recent 30 days",
  });

  const observedSpan = await spanQuery(
    pool,
    PROFILE_PROBE_SQL.observedEventTimeSpan,
    nowMs,
  );
  results.observedEventTimeSpan = observedSpan;
  appendSpanFailures(failures, "observed", observedSpan, {
    minRecentMs: PROFILE_THRESHOLDS.observedEventTimeMinSpanMs,
    maxStalenessMs: PROFILE_THRESHOLDS.maxEventTimeStalenessMs,
    tableLabel: "observed_event_meta",
    requirementLabel: "the full 30-day retention window",
  });

  const corpus = await corpusStateQuery(pool, PROFILE_PROBE_SQL.corpusState);
  results.corpusState = corpus;
  if (corpus === null) {
    failures.push({
      check: "corpusState",
      detail:
        "baseline_corpus_state row absent; profile requires last_run_status = " +
        "'ok' AND last_ingested_at < 2h ago",
    });
  } else {
    if (corpus.lastRunStatus !== "ok") {
      failures.push({
        check: "corpusStateStatus",
        detail:
          `baseline_corpus_state.last_run_status = ${JSON.stringify(corpus.lastRunStatus)}; ` +
          "profile requires 'ok' so steady-state plans are measured, not partial first-ingest",
      });
    }
    if (corpus.lastIngestedAtMs === null) {
      failures.push({
        check: "corpusStateFreshness",
        detail:
          "baseline_corpus_state.last_ingested_at is NULL; profile requires < 2h ago",
      });
    } else {
      const ageMs = nowMs - corpus.lastIngestedAtMs;
      if (ageMs >= PROFILE_THRESHOLDS.maxCorpusStalenessMs) {
        failures.push({
          check: "corpusStateFreshness",
          detail:
            `baseline_corpus_state.last_ingested_at is ${formatMs(ageMs)} old; ` +
            "profile requires < 2h ago",
        });
      }
    }
  }

  // Story-shape additions (issue #601). Only the structured form
  // carries a `memberScan` range — bare-number / undefined callers
  // skip these. Note the `story_finalized_through` check fires even
  // when `memberScan` is absent because it is a precondition on the
  // tenant, not on the range.
  const storyWatermark = await storyFinalizedThroughQuery(
    pool,
    PROFILE_PROBE_SQL.storyFinalizedThrough,
  );
  results.storyFinalizedThrough = storyWatermark;
  if (storyWatermark === null || storyWatermark === undefined) {
    failures.push({
      check: "storyFinalizedThrough",
      detail:
        "baseline_corpus_state.story_finalized_through IS NULL; profile " +
        "requires a finalized watermark so the slop-replay measurement " +
        "is actually exercised (the gate's purpose). Fresh tenants " +
        "without a cadence tick are not gate-eligible.",
    });
  }

  if (memberScan !== null && memberScan !== undefined) {
    if (memberScan.startIso === null) {
      // The harness only invokes this branch when the watermark
      // exists; if `storyFinalizedThrough` already failed above we
      // skip the candidate-count probe to avoid a misleading second
      // failure on the same root cause.
    } else {
      const phase1Count = await slopReplayPhase1CountQuery(
        pool,
        memberScan.startIso,
        memberScan.endIso,
      );
      results.slopReplayPhase1Count = phase1Count;
      if (phase1Count < PROFILE_THRESHOLDS.minSlopReplayPhase1Candidates) {
        failures.push({
          check: "slopReplayPhase1Count",
          detail:
            `R3 phase-1 over the slop-replay scan range returned ` +
            `${phase1Count} candidate asset(s); profile requires ` +
            `≥ ${PROFILE_THRESHOLDS.minSlopReplayPhase1Candidates} so ` +
            "phase-2's per-asset GiST probe pattern is actually exercised. " +
            "A tenant with zero or near-zero candidates in the slop-replay " +
            "scan range produces a meaningless plan reading.",
        });
      }
    }
  }

  if (failures.length > 0) {
    throw new ProfileAssertionError(failures);
  }
  return results;
}

/**
 * Normalize the backwards-compatible second argument to
 * `assertRepresentativeProfile`. Accepts:
 *
 *   * `undefined` — uses `Date.now()`, no Story-shape checks.
 *   * a bare `number` — legacy callers; treated as `{ nowMs }` with
 *     no Story-shape checks beyond the `story_finalized_through`
 *     precondition.
 *   * a structured object `{ nowMs?, memberScan? }` — issue #601
 *     callers; enables every Story-shape check the `memberScan`
 *     range allows.
 */
function normalizeAssertOpts(opts) {
  if (opts === undefined || opts === null) {
    return { nowMs: Date.now(), memberScan: null };
  }
  if (typeof opts === "number") {
    return { nowMs: opts, memberScan: null };
  }
  return {
    nowMs: typeof opts.nowMs === "number" ? opts.nowMs : Date.now(),
    memberScan: opts.memberScan ?? null,
  };
}

async function scalarCount(pool, sql) {
  const { rows } = await pool.query(sql);
  if (rows.length === 0) return 0;
  return Number(rows[0].count);
}

async function spanQuery(pool, sql, nowMs) {
  const { rows } = await pool.query(sql);
  if (rows.length === 0 || rows[0].lo === null) {
    return {
      lo: null,
      hi: null,
      historicalSpanMs: 0,
      stalenessMs: Number.POSITIVE_INFINITY,
    };
  }
  const lo = new Date(rows[0].lo).getTime();
  const hi = new Date(rows[0].hi).getTime();
  return {
    lo: rows[0].lo,
    hi: rows[0].hi,
    // `historicalSpanMs` answers "does the corpus extend back ≥ N
    // days?" — independent of how recent the newest row is.
    historicalSpanMs: hi - lo,
    // `stalenessMs` answers "is the newest row recent?" — a corpus
    // whose newest row is six months old has zero coverage of the
    // recent window the harness is about to probe, so the planner
    // estimates would be unrepresentative even if `hi - lo` is wide.
    stalenessMs: Math.max(0, nowMs - hi),
  };
}

/**
 * Translate one `{historicalSpanMs, stalenessMs}` result from
 * `spanQuery` into zero-or-more failures. Splitting "history extends
 * back" and "high-water mark is recent" lets the failure message tell
 * the operator which side is wrong — operator gets a 30-day-only
 * corpus or a stale-high-water-mark corpus, not a single span
 * coverage number that conflates the two.
 */
function appendSpanFailures(failures, key, span, opts) {
  if (span.lo === null) {
    failures.push({
      check: `${key}EventTimeSpan`,
      detail: `${opts.tableLabel} is empty; profile requires ${opts.requirementLabel}`,
    });
    return;
  }
  if (span.historicalSpanMs < opts.minRecentMs) {
    failures.push({
      check: `${key}EventTimeSpan`,
      detail:
        `${opts.tableLabel} spans only ${formatMs(span.historicalSpanMs)} ` +
        `from oldest to newest row; profile requires ${opts.requirementLabel}`,
    });
  }
  if (span.stalenessMs > opts.maxStalenessMs) {
    failures.push({
      check: `${key}EventTimeFreshness`,
      detail:
        `${opts.tableLabel} newest row is ${formatMs(span.stalenessMs)} old; ` +
        `profile requires the newest row within ${formatMs(opts.maxStalenessMs)} ` +
        "so the recent window the harness probes is actually populated",
    });
  }
}

async function corpusStateQuery(pool, sql) {
  const { rows } = await pool.query(sql);
  if (rows.length === 0) return null;
  return {
    lastRunStatus: rows[0].last_run_status,
    lastIngestedAtMs:
      rows[0].last_ingested_at === null
        ? null
        : new Date(rows[0].last_ingested_at).getTime(),
  };
}

async function storyFinalizedThroughQuery(pool, sql) {
  const { rows } = await pool.query(sql);
  if (rows.length === 0) return null;
  const value = rows[0].story_finalized_through;
  if (value === null || value === undefined) return null;
  return new Date(value).toISOString();
}

async function slopReplayPhase1CountQuery(pool, startIso, endIso) {
  const { rows } = await pool.query(PROFILE_SLOP_REPLAY_PHASE1_SQL, [
    startIso,
    endIso,
    CRITICAL_SELECTOR_ARRAY,
  ]);
  // The phase-1 SELECT returns one row per candidate asset, deduped
  // by the SQL `GROUP BY orig_addr`. Length of the row set is the
  // candidate count — no extra `COUNT(*)` round trip needed.
  return rows.length;
}

function formatMs(ms) {
  if (ms < 0) return "0 (newest row in the future)";
  const days = ms / (24 * 60 * 60 * 1000);
  if (days >= 1) return `${days.toFixed(1)} day(s)`;
  const hours = ms / (60 * 60 * 1000);
  if (hours >= 1) return `${hours.toFixed(1)} hour(s)`;
  const minutes = ms / (60 * 1000);
  return `${minutes.toFixed(1)} minute(s)`;
}

/**
 * Build the multi-line error message the harness writes to stderr on
 * profile-assertion failure. Kept here so the test can assert the
 * shape without rebuilding it from the failures list.
 */
export function formatProfileAssertionFailure(err) {
  const lines = [
    `[measure-baseline-read-path] FAIL — representative profile not met (${err.failures.length} check(s)):`,
    "",
  ];
  for (const f of err.failures) {
    lines.push(`  • ${f.check}: ${f.detail}`);
  }
  lines.push("");
  lines.push(
    "Refusing to run. The harness's contract with #528 is that every measurement",
  );
  lines.push(
    "reflects production-shaped data — a tenant that does not meet the profile",
  );
  lines.push(
    "produces timings #528 cannot generalize. Re-run against a representative",
  );
  lines.push(
    "tenant, or pass --skip-profile-assert when developing the harness itself.",
  );
  return lines.join("\n");
}
