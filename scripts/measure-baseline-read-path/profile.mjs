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
};

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
 */
export async function assertRepresentativeProfile(pool, nowMs = Date.now()) {
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

  if (failures.length > 0) {
    throw new ProfileAssertionError(failures);
  }
  return results;
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
