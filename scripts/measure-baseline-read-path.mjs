#!/usr/bin/env node
// Phase 1.B menu read-path measurement harness (issue #524).
//
// Produces per-query latency samples that #528 consumes to derive p50 /
// p95 numbers and to record `EXPLAIN (ANALYZE, BUFFERS, VERBOSE)` plans
// on a representative staging tenant. The harness itself emits raw
// samples — it does NOT compute statistics, gate the build, or sign off
// on rollout.
//
// Invocation
// ----------
//
//   pnpm node scripts/measure-baseline-read-path.mjs \
//     --connection-string="postgres://user:pass@host:5432/tenant_db" \
//     --window=30d \
//     [--cold-command="<shell>"] \
//     [--warmups=5] \
//     [--samples=30] \
//     [--output=json|tsv] \
//     [--skip-profile-assert]
//
// `--connection-string` is mandatory and points at the per-tenant DB
// the harness should measure. `--window=Nd` selects the period length;
// the harness derives `[periodStart, periodEnd)` as `[now − N days,
// now)`. `--window=Nh` is also accepted.
//
// `--cold-command="<shell>"` is the cold-cache reference hook. When
// present, the harness invokes the supplied shell command once
// before EACH measured query and then records one cold-cache sample
// for that query on a fresh connection. The per-query re-invocation
// is required because the first cold sample warms the shared buffers
// / OS cache; without re-establishing cold state between queries,
// only the first query would observe a genuine cold cache and the
// remaining `phase: "cold"` rows would silently be warm-after-cold.
// The cold sample uses the same `EXPLAIN ANALYZE` form the warm
// samples use, so the timings are directly comparable. The cold
// phase has atomic semantics: if any cold-command invocation exits
// non-zero (or by signal), the harness emits NO `phase: "cold"`
// rows and records the failure in `meta.coldReading`. Partial cold
// phases are deliberately not emitted because #528 would otherwise
// silently mix genuine cold readings with warm-after-cold readings.
// Labels by mode:
//
//   * absent  — `"cold reading: not available — host policy"`
//   * captured — `"cold reading: captured via --cold-command=…
//                   (one invocation per measured query)"`
//   * failed   — `"cold reading: --cold-command=… exited N;
//                   no cold-phase samples emitted (cold state was
//                   not established)"` (failure on the first query)
//                or `"cold reading: --cold-command=… failed on query
//                   K/N (<queryName>); no cold-phase samples emitted
//                   (cold state was not established for all
//                   measured queries)"` (failure mid-phase).
//
// The harness never restarts Postgres or drops OS caches on its
// own because those operations are destructive on a shared staging
// DB. Connection drop/recreate is NOT cold (shared buffers and OS
// cache survive) and `pg_prewarm` is warm-side tooling — neither is
// used as a cold-cache approximation.
//
// Typical local-only `--cold-command` value (Linux dev box):
//   --cold-command="sudo systemctl restart postgresql && \
//                   sudo sync && \
//                   sudo sh -c 'echo 3 > /proc/sys/vm/drop_caches'"
// Whatever value the operator passes must be recorded in the #528 PR
// so the cold environment is auditable.
//
// Per query, per window: 5 warm-up runs (timings discarded) + 30
// sample runs back-to-back against the same connection. Each sample
// is run as `EXPLAIN ANALYZE` so the emitted `elapsedMs` is the
// server-side execution time the planner observed, not a client-side
// wall-clock that mixes in result-set serialization and round trip.
// The first warm-sample run for each query uses the `EXPLAIN
// (ANALYZE, BUFFERS, VERBOSE)` form and its plan text is recorded in
// `meta.explainByQuery` so #528 can attribute timings to a planner
// choice. Cold-phase samples (when `--cold-command` is provided) run
// the same `EXPLAIN ANALYZE` once per query before warm-up — with
// the cold command re-invoked between queries on a fresh connection
// so each cold sample observes a genuinely cold cache — so cold
// numbers are directly comparable to warm numbers.
//
// Output
// ------
//
// Default JSON to stdout. One top-level object with `meta` (run
// config, resolved window, cold-reading label, `notMeasurable`
// entries) and `samples` (one row per query × context × sample ×
// phase). `--output=tsv` emits a tab-separated table with columns:
// query, context, phase, sample_index, elapsed_ms, row_count. The
// structured-JSON shape is the canonical form #528 consumes; TSV is
// a convenience for ad-hoc inspection.
//
// `context` is the cadence-context discriminator added in #601: the
// menu queries surface as `"default"`; R1 / R3 entries surface as
// `"first-tick"` or `"slop-replay"`. The warm and cold loops iterate
// `queries × contexts`, so the same query name appears under
// multiple contexts within one run.
//
// Sample row (JSON):
//   { "query": "selectMenuCohort", "context": "default",
//     "phase": "warm", "sampleIndex": 0, "elapsedMs": 18.42,
//     "rowCount": 1837 }
//
// `EXPLAIN` plans live under `meta.explainByQuery`, keyed by
// `"<name>:<context>"` (e.g. `"readR3CandidatesPhase1:slop-replay"`)
// so the same query name under different contexts gets distinct plan
// entries. The harness emits the raw multi-line plan text from the
// first warm-sample run's `EXPLAIN (ANALYZE, BUFFERS, VERBOSE)` so
// #528's consumer can pretty-print or summarize as it sees fit.
//
// `meta.notMeasurable` (added in #601) is an array of
// `{ query, context, reason }` entries for (query, context) pairs
// the harness intentionally skipped — currently R3 phase-2 when its
// phase-1 probe returned zero assets, and slop-replay-context
// entries when `story_finalized_through IS NULL`. No `samples` row
// is emitted for a skipped pair; #528 rejects any run whose
// `meta.notMeasurable` is non-empty for a gate-required query.
//
// Profile assertion
// -----------------
//
// Before running per-query measurements the harness asserts the
// connected DB matches the representative profile and aborts with a
// clear error otherwise. The profile thresholds are co-located with
// the assertion code (`profile.mjs`) so updates to the thresholds and
// the SQL that probes them live in one place — keep this header in
// sync if the thresholds change in a way operators need to know:
//
//   * `baseline_triaged_event` row count ≥ 200,000.
//   * `observed_event_meta` row count ≥ 1,000,000.
//   * Distinct `(kind, baseline_version)` partitions ≥ 4 (so the
//     `cume_dist() OVER (PARTITION BY ...)` window function exercises
//     real partitioning, not a degenerate single-partition case).
//   * Distinct `orig_addr` in `baseline_triaged_event` ≥ 500.
//   * `event_time` coverage in `baseline_triaged_event` spans at least
//     the most recent 30 days, AND `observed_event_meta` spans its full
//     30-day retention window.
//   * `baseline_corpus_state.last_run_status = 'ok'` AND
//     `last_ingested_at < 2h ago` so steady-state plans are measured,
//     not partial first-ingest.
//   * `baseline_corpus_state.story_finalized_through IS NOT NULL`
//     (#601) so the slop-replay measurement is actually exercised.
//     Fresh tenants without a cadence tick are not gate-eligible.
//   * R3 phase-1 over the slop-replay scan range returns ≥ 5
//     candidate asset(s) (#601). The assertion runs the same
//     phase-1 SQL the harness measures, so the count reflects the
//     scan the gate will actually exercise — counting `event_group`
//     rows globally would be a weak pass signal because it does not
//     guarantee any R3 candidates exist in the slop-replay range.
//
// `--skip-profile-assert` exists as a developer escape hatch when
// running the harness against synthetic fixtures during script
// development. Production / staging runs MUST NOT pass this flag — the
// #528 measurement campaign assumes a profile-conformant tenant.

import { spawnSync } from "node:child_process";
import pg from "pg";

import { addressesFromCohortRows } from "../src/lib/triage/baseline/compose.mjs";
import {
  MEASURED_QUERIES,
  MENU_CANDIDATES_PER_BUCKET,
  SELECT_MENU_COHORT_SQL,
} from "../src/lib/triage/baseline/read-path-sql.mjs";
import { CRITICAL_SELECTOR_SET } from "../src/lib/triage/story/critical-sets.mjs";
import { buildReadR3CandidatesPhase1Sql } from "../src/lib/triage/story/read-path-sql.mjs";
import {
  assertRepresentativeProfile,
  formatProfileAssertionFailure,
  ProfileAssertionError,
} from "./measure-baseline-read-path/profile.mjs";

// `MAX_RULE_WINDOW_MS` mirrors `src/lib/triage/story/rules.ts` —
// inlined here for the plain-Node constraint. The slop-replay
// measurement context binds `[story_finalized_through −
// MAX_RULE_WINDOW_MS, new_horizon]` so the planner sees a
// production-shape lookback range.
const MAX_RULE_WINDOW_MS = 60 * 60 * 1000;
// `SLOP_WINDOW_MS` mirrors `src/lib/triage/story/rules.ts`. Cadence
// chooses `new_horizon = page_max_event_time − SLOP_WINDOW_MS`; the
// harness picks `new_horizon = now − SLOP_WINDOW_MS` so the bind is a
// representative cadence horizon, not an out-of-corpus future point.
const SLOP_WINDOW_MS = 30 * 60 * 1000;
const CRITICAL_SELECTOR_ARRAY = Array.from(CRITICAL_SELECTOR_SET);

const DEFAULT_WARMUPS = 5;
const DEFAULT_SAMPLES = 30;
const DEFAULT_OUTPUT = "json";

function parseArgs(argv) {
  const args = {
    connectionString: null,
    window: "30d",
    coldCommand: null,
    warmups: DEFAULT_WARMUPS,
    samples: DEFAULT_SAMPLES,
    output: DEFAULT_OUTPUT,
    skipProfileAssert: false,
  };
  for (const raw of argv.slice(2)) {
    if (raw === "--skip-profile-assert") {
      args.skipProfileAssert = true;
      continue;
    }
    const eq = raw.indexOf("=");
    if (!raw.startsWith("--") || eq === -1) {
      throw new Error(`unrecognized argument: ${raw}`);
    }
    const key = raw.slice(2, eq);
    const value = raw.slice(eq + 1);
    switch (key) {
      case "connection-string":
        args.connectionString = value;
        break;
      case "window":
        args.window = value;
        break;
      case "cold-command":
        args.coldCommand = value;
        break;
      case "warmups":
        args.warmups = Number.parseInt(value, 10);
        break;
      case "samples":
        args.samples = Number.parseInt(value, 10);
        break;
      case "output":
        args.output = value;
        break;
      default:
        throw new Error(`unrecognized flag: --${key}`);
    }
  }
  if (!args.connectionString) {
    throw new Error("missing required flag: --connection-string=<dsn>");
  }
  if (!Number.isFinite(args.warmups) || args.warmups < 0) {
    throw new Error(`invalid --warmups: ${args.warmups}`);
  }
  if (!Number.isFinite(args.samples) || args.samples < 1) {
    throw new Error(`invalid --samples: ${args.samples}`);
  }
  if (args.output !== "json" && args.output !== "tsv") {
    throw new Error(`invalid --output: ${args.output} (expected json|tsv)`);
  }
  return args;
}

/**
 * Resolve `--window=Nd` / `--window=Nh` to a half-open
 * `[start, end)` ISO pair anchored at `now`.
 */
export function resolveWindow(spec, nowMs = Date.now()) {
  const match = /^(\d+)([dh])$/.exec(spec);
  if (match === null) {
    throw new Error(
      `invalid --window: ${spec} (expected <N>d or <N>h, e.g. 30d or 6h)`,
    );
  }
  const n = Number.parseInt(match[1], 10);
  const unitMs = match[2] === "d" ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  const endMs = nowMs;
  const startMs = endMs - n * unitMs;
  return {
    periodStartIso: new Date(startMs).toISOString(),
    periodEndIso: new Date(endMs).toISOString(),
  };
}

/**
 * Run the operator-supplied cold command once. Returns a
 * `{mode, label}` pair so the caller can distinguish three cases
 * without parsing the free-form label:
 *
 *   * `mode: "absent"`  — no `--cold-command` was supplied (default
 *     behavior). Caller proceeds to warm-up; no cold samples are
 *     emitted.
 *   * `mode: "captured"` — command exited 0. The DB / page cache is
 *     in a freshly-cold state on the connection the caller opens
 *     next.
 *   * `mode: "failed"`   — command exited non-zero (or by signal).
 *     Caller must NOT emit cold-phase samples for this invocation
 *     because no cold state was established. The failure surfaces in
 *     `meta.coldReading` so #528 sees why no cold samples appear.
 *
 * Note: a single `runColdCommand` invocation establishes cold state
 * for ONE subsequent query only. The cold phase invokes this once
 * per measured query (orchestrated by `runColdPhase`) so each cold
 * sample observes a genuinely cold cache — see that helper for the
 * atomic-semantics rationale.
 *
 * `spawn` is injected so tests can exercise the non-zero-exit branch
 * without invoking a real shell.
 */
export function runColdCommand(cmd, spawn = spawnSync) {
  if (cmd === null || cmd === undefined) {
    return {
      mode: "absent",
      label: "cold reading: not available — host policy",
    };
  }
  const result = spawn(cmd, { shell: true, stdio: "inherit" });
  if (result.status === 0) {
    return {
      mode: "captured",
      label:
        `cold reading: captured via --cold-command=${JSON.stringify(cmd)} ` +
        "(one invocation per measured query)",
    };
  }
  return {
    mode: "failed",
    label:
      `cold reading: --cold-command=${JSON.stringify(cmd)} exited ` +
      `${result.status ?? "<signal>"}; no cold-phase samples emitted ` +
      "(cold state was not established)",
  };
}

/**
 * Run the cold phase atomically: for each measured query, invoke the
 * operator-supplied cold command on a fresh `pg.Pool` and capture one
 * `phase: "cold"` sample for that query. The per-query re-invocation
 * is intentional — after the first cold sample executes, the
 * underlying tables are warm in shared buffers and OS cache, so
 * queries 2..N would otherwise see a warm-after-cold state and the
 * emitted `phase: "cold"` rows past the first would be mislabeled.
 *
 * Atomic semantics: if any cold-command invocation fails (non-zero
 * exit, signal exit, or absent on the first iteration when one was
 * expected), the harness emits NO cold-phase samples and records the
 * failure in `meta.coldReading`. A partial cold phase would force
 * #528 to special-case "queries 1..K are cold, K+1..N are missing or
 * worse warm-after-cold" — better to emit none than a confusing mix.
 *
 * `makePool` and `spawn` are injected so tests can exercise the
 * orchestration (pool lifecycle, per-query invocation count, atomic-
 * failure paths) without a real Postgres or a real subprocess.
 */
export async function runColdPhase({
  coldCommand,
  queries,
  ctx,
  makePool,
  spawn = spawnSync,
}) {
  if (coldCommand === null || coldCommand === undefined) {
    return { samples: [], label: runColdCommand(null, spawn).label };
  }
  const samples = [];
  let lastLabel = null;
  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    const cold = runColdCommand(coldCommand, spawn);
    if (cold.mode !== "captured") {
      if (i === 0) {
        return { samples: [], label: cold.label };
      }
      return {
        samples: [],
        label:
          `cold reading: --cold-command=${JSON.stringify(coldCommand)} ` +
          `failed on query ${i + 1}/${queries.length} ` +
          `(${formatQueryLabel(query)}); ` +
          "no cold-phase samples emitted (cold state was not established " +
          "for all measured queries)",
      };
    }
    lastLabel = cold.label;
    const pool = makePool();
    try {
      const client = await pool.connect();
      try {
        samples.push(await coldSampleQuery(client, query, ctx));
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  }
  return {
    samples,
    label: lastLabel ?? runColdCommand(null, spawn).label,
  };
}

/**
 * Render a measured-query entry as `"<name>:<context>"` for log /
 * label use. The context suffix lets operators (and the cold-failure
 * test) distinguish which (query, context) pair failed when the same
 * query name is exercised under both first-tick and slop-replay.
 */
export function formatQueryLabel(query) {
  return query.context ? `${query.name}:${query.context}` : query.name;
}

/**
 * Pick the addresses production would surface for one menu load by
 * replaying the full read-path pipeline:
 *
 *   1. Run the shared `SELECT_MENU_COHORT_SQL` (same byte-for-byte
 *      string production uses).
 *   2. Feed the rows into `addressesFromCohortRows` from the shared
 *      `compose.mjs` module, which runs `composeMenu` and then
 *      replays `uniqueAddresses(events)` over the resulting menu
 *      rows. Same composition code as `composeMenuFromCohort` in
 *      `server-actions.ts`. `menuCutoff` is passed through to
 *      `composeMenu`'s row filter (RFC §6 option (a)); it is NOT a
 *      SQL bind because production keeps the cutoff at the
 *      composition step to preserve the full-cohort bucket aggregates
 *      that drive quota allocation.
 *
 * This gives the planner the exact `ANY($3::inet[])` cardinality and
 * address distribution production sees after §4 per-bucket quota and
 * the §6 `MIN_NONZERO_FLOOR` fallback have run.
 *
 * NOTE: the harness does NOT cap the address list at
 * `TRIAGE_ASSET_PAGE_SIZE`. `loadCustomerSlice` drives the per-tenant
 * fanout from `uniqueAddresses(events)` *without* a cap
 * (`src/lib/triage/server-actions.ts:217-223`); the
 * `TRIAGE_ASSET_PAGE_SIZE` cap only applies to the aggregated, sorted
 * asset list at the end of `loadTriagePeriod`
 * (`src/lib/triage/server-actions.ts:533`). `default_N` is unbounded
 * (`computeDefaultN` in `compose.mjs`), so a representative tenant
 * may legitimately send `perAssetObservedCounts` /
 * `selectAssetDetailEventsBatch` an `ANY($3::inet[])` array larger
 * than 100, and the harness must reproduce that.
 */
export async function sampleAddresses(
  pool,
  periodStartIso,
  periodEndIso,
  menuCutoff = 0,
) {
  const { rows } = await pool.query(SELECT_MENU_COHORT_SQL, [
    periodStartIso,
    periodEndIso,
    MENU_CANDIDATES_PER_BUCKET,
  ]);
  return addressesFromCohortRows(rows, { cutoff: menuCutoff });
}

/**
 * Parse the text-format `EXPLAIN ANALYZE` output Postgres emits.
 * Returns the server-side execution time (in ms) and the top-level
 * plan node's actual row count. Throws if `Execution Time:` is
 * missing — that would indicate either a non-ANALYZE EXPLAIN was run
 * by mistake or the Postgres version emits a different format than
 * supported here.
 */
export function parseExplainAnalyze(planText) {
  let executionMs = null;
  let actualRows = null;
  for (const line of planText.split("\n")) {
    const execMatch = /^Execution Time:\s+([\d.]+)\s+ms/.exec(line);
    if (execMatch !== null) executionMs = Number.parseFloat(execMatch[1]);
    if (actualRows === null) {
      const topMatch = /actual time=[\d.]+\.\.[\d.]+ rows=(\d+) loops=/.exec(
        line,
      );
      if (topMatch !== null) actualRows = Number.parseInt(topMatch[1], 10);
    }
  }
  if (executionMs === null) {
    throw new Error(
      `unable to parse EXPLAIN ANALYZE output (missing "Execution Time"): ${planText.slice(0, 400)}`,
    );
  }
  return { elapsedMs: executionMs, rowCount: actualRows ?? 0 };
}

/**
 * Run one `EXPLAIN ANALYZE` execution and return the parsed timing
 * alongside the raw plan text. `verbose` selects between the
 * `(ANALYZE, BUFFERS, VERBOSE)` form (captured once per query as the
 * planner-choice snapshot) and the lighter `(ANALYZE)` form used for
 * the remaining samples.
 */
async function explainAnalyzeSample(client, sql, params, verbose) {
  const options = verbose ? "ANALYZE, BUFFERS, VERBOSE" : "ANALYZE";
  const { rows } = await client.query(`EXPLAIN (${options}) ${sql}`, params);
  const planText = rows.map((r) => r["QUERY PLAN"]).join("\n");
  const { elapsedMs, rowCount } = parseExplainAnalyze(planText);
  return { elapsedMs, rowCount, planText };
}

async function measureQuery(client, query, ctx, warmups, samples) {
  const params = query.buildParams(ctx);
  for (let i = 0; i < warmups; i++) {
    await client.query(query.sql, params);
  }
  let verbosePlan = null;
  const queryRows = [];
  // Samples run serially against the same connection — concurrent
  // execution would invalidate the per-query timing. The first
  // sample doubles as the planner-choice snapshot via the VERBOSE
  // form, and its `elapsedMs` is the EXPLAIN ANALYZE execution time
  // reported on the same run.
  for (let i = 0; i < samples; i++) {
    const verbose = i === 0;
    const { elapsedMs, rowCount, planText } = await explainAnalyzeSample(
      client,
      query.sql,
      params,
      verbose,
    );
    if (verbose) verbosePlan = planText;
    queryRows.push({
      query: query.name,
      context: query.context ?? "default",
      phase: "warm",
      sampleIndex: i,
      elapsedMs,
      rowCount,
    });
  }
  return { samples: queryRows, verbosePlan };
}

async function coldSampleQuery(client, query, ctx) {
  const params = query.buildParams(ctx);
  const { elapsedMs, rowCount } = await explainAnalyzeSample(
    client,
    query.sql,
    params,
    false,
  );
  return {
    query: query.name,
    context: query.context ?? "default",
    phase: "cold",
    sampleIndex: 0,
    elapsedMs,
    rowCount,
  };
}

function emitJson(meta, samples) {
  process.stdout.write(`${JSON.stringify({ meta, samples }, null, 2)}\n`);
}

function emitTsv(meta, samples) {
  process.stdout.write("# meta\n");
  for (const [k, v] of Object.entries(meta)) {
    process.stdout.write(
      `# ${k}\t${typeof v === "object" ? JSON.stringify(v) : v}\n`,
    );
  }
  // Sample-row schema gains `context` (issue #601): cadence entries
  // emit `first-tick` / `slop-replay`, menu entries emit `default`.
  process.stdout.write(
    "query\tcontext\tphase\tsample_index\telapsed_ms\trow_count\n",
  );
  for (const r of samples) {
    process.stdout.write(
      `${r.query}\t${r.context}\t${r.phase}\t${r.sampleIndex}\t${r.elapsedMs.toFixed(3)}\t${r.rowCount}\n`,
    );
  }
}

/**
 * Run the R3 phase-1 SELECT once per measurement context against the
 * supplied probe pool, dedupe each result, and return the two asset
 * lists keyed by context. Phase-2's `$N::inet[]` parameter is
 * derived from this output: phase-1 returns the set of `orig_addr`
 * values that meet R3's `COUNT(*) >= 3` threshold, and phase-2 then
 * fans out into per-asset GiST index probes against that set.
 *
 * The two lists are deliberately independent — phase-1's scan range
 * differs between first-tick (`event_time <= memberScanEnd`) and
 * slop-replay (`event_time >= memberScanStart AND <= memberScanEnd`),
 * so the candidate-asset cardinality and identity can also differ.
 *
 * Returns `{firstTick, slopReplay}`, each a string[] of the deduped
 * asset list. Either list may be empty; the caller emits a
 * `meta.notMeasurable` entry per empty list and skips the matching
 * phase-2 (query, context) measurement.
 */
export async function probeR3CandidateAssets(pool, ctx) {
  const firstTick = await runPhase1Probe(pool, {
    memberScanStartIsNull: true,
    params: [ctx.memberScanEndIso, CRITICAL_SELECTOR_ARRAY],
  });
  const slopReplay =
    ctx.memberScanStartIso === null
      ? []
      : await runPhase1Probe(pool, {
          memberScanStartIsNull: false,
          params: [
            ctx.memberScanStartIso,
            ctx.memberScanEndIso,
            CRITICAL_SELECTOR_ARRAY,
          ],
        });
  return { firstTick, slopReplay };
}

async function runPhase1Probe(pool, { memberScanStartIsNull, params }) {
  const sql = buildReadR3CandidatesPhase1Sql({ memberScanStartIsNull });
  const { rows } = await pool.query(sql, params);
  return Array.from(
    new Set(
      rows
        .map((r) => r.orig_addr)
        .filter((a) => typeof a === "string" && a.length > 0),
    ),
  );
}

/**
 * Read `baseline_corpus_state.story_finalized_through` from the probe
 * pool, returning the value as ms since epoch or `null` when the
 * cadence has never advanced the watermark. The slop-replay
 * measurement context derives its `memberScanStart` from this value
 * — a fresh tenant (`null`) is fine for the first-tick context but
 * not for the gate-required slop-replay context, which the profile
 * assertion enforces.
 */
export async function readStoryFinalizedThroughMs(pool) {
  const { rows } = await pool.query(
    `SELECT story_finalized_through FROM baseline_corpus_state WHERE id = true`,
  );
  if (rows.length === 0 || rows[0].story_finalized_through === null) {
    return null;
  }
  return new Date(rows[0].story_finalized_through).getTime();
}

/**
 * Partition the registered measured queries into a measurable subset
 * and a `notMeasurable` list. The harness skips the not-measurable
 * (query, context) pairs in both warm and cold phases and records
 * them in `meta.notMeasurable` so #528 can detect the silent-skip
 * regression.
 *
 * Phase-2 entries become not-measurable when the matching phase-1
 * probe returned zero assets — the `ANY($::inet[])` bind would be
 * empty and the plan would degenerate (no rows scanned, no useful
 * timing). Per the contract locked in by issue #601, the harness
 * does NOT emit `samples` rows for these; the absence is intentional
 * and `meta.notMeasurable` is the load-bearing signal.
 */
export function partitionMeasurableQueries(queries, ctx) {
  const measurable = [];
  const notMeasurable = [];
  for (const q of queries) {
    // Slop-replay binds `$N = memberScanStartIso`. When the cadence
    // has never advanced the watermark (`story_finalized_through IS
    // NULL`), the bind is `null` and the SELECT degenerates — fail
    // closed via `notMeasurable` so #528 sees the explicit skip.
    if (q.context === "slop-replay" && ctx.memberScanStartIso === null) {
      notMeasurable.push({
        query: q.name,
        context: q.context,
        reason:
          "baseline_corpus_state.story_finalized_through IS NULL " +
          "(no previous watermark — slop-replay path not exercised)",
      });
      continue;
    }
    if (q.name === "readR3CandidatesPhase2") {
      const key = q.context === "first-tick" ? "firstTick" : "slopReplay";
      const assets = ctx.r3CandidateAssets?.[key] ?? [];
      if (assets.length === 0) {
        notMeasurable.push({
          query: q.name,
          context: q.context,
          reason: "phase-1 returned 0 assets",
        });
        continue;
      }
    }
    measurable.push(q);
  }
  return { measurable, notMeasurable };
}

async function main(argv) {
  const args = parseArgs(argv);
  const nowMs = Date.now();
  const { periodStartIso, periodEndIso } = resolveWindow(args.window, nowMs);
  // `observedFromIso` matches the production formula in
  // `server-actions.ts`: `max(periodStart, now() - retention)`. The
  // retention floor is hard-coded to 30 days here to mirror the
  // production constant; if it changes there, update this comment and
  // the matching value below.
  const retentionMs = 30 * 24 * 60 * 60 * 1000;
  const observedFromMs = Math.max(
    Date.parse(periodStartIso),
    nowMs - retentionMs,
  );
  const observedFromIso = new Date(observedFromMs).toISOString();

  // `memberScanEnd` mirrors the cadence's `new_horizon = page_max −
  // SLOP_WINDOW_MS` (Story RFC §3 / §4). The harness picks `now −
  // SLOP_WINDOW_MS` so the bind is a representative cadence horizon
  // — close to the corpus high-water mark the profile assertion
  // already required is within 2 hours of now.
  const memberScanEndMs = nowMs - SLOP_WINDOW_MS;
  const memberScanEndIso = new Date(memberScanEndMs).toISOString();

  // First connection: profile assertion + address sampling + Story
  // cadence-shape probes. We close this pool before invoking
  // `--cold-command` so a destructive cold command (e.g.
  // `systemctl restart postgresql`) cannot strand in-flight queries
  // or leak a dead connection into the measurement pool below.
  let addresses;
  let storyFinalizedThroughMs = null;
  let r3CandidateAssets = { firstTick: [], slopReplay: [] };
  // `memberScanStartIso` mirrors the cadence's
  // `previous_watermark − MAX_RULE_WINDOW_MS` (slop replay). Null
  // when the tenant has never finalized a watermark — in that case
  // only the first-tick context is measurable.
  let memberScanStartIso = null;
  {
    const probePool = new pg.Pool({ connectionString: args.connectionString });
    try {
      // Read the current Story watermark before the profile assertion
      // so the assertion can be threaded the slop-replay scan range
      // it needs to count phase-1 candidate assets.
      storyFinalizedThroughMs = await readStoryFinalizedThroughMs(probePool);
      if (storyFinalizedThroughMs !== null) {
        memberScanStartIso = new Date(
          storyFinalizedThroughMs - MAX_RULE_WINDOW_MS,
        ).toISOString();
      }
      if (!args.skipProfileAssert) {
        try {
          await assertRepresentativeProfile(probePool, {
            nowMs,
            memberScan: {
              startIso: memberScanStartIso,
              endIso: memberScanEndIso,
            },
          });
        } catch (err) {
          if (err instanceof ProfileAssertionError) {
            process.stderr.write(formatProfileAssertionFailure(err));
            process.stderr.write("\n");
            return 2;
          }
          throw err;
        }
      }

      // Replay the production composition pipeline to derive the
      // address list. Intentionally NOT capped at
      // `TRIAGE_ASSET_PAGE_SIZE`: `loadCustomerSlice` drives the
      // per-tenant fanout from the uncapped `uniqueAddresses(events)`
      // (`server-actions.ts:217-223`), and the 100-asset cap only
      // applies to the aggregated asset list at the very end of
      // `loadTriagePeriod`. `default_N` is not bounded to 100, so the
      // planner can legitimately see >100 addresses in production.
      addresses = await sampleAddresses(
        probePool,
        periodStartIso,
        periodEndIso,
      );

      // Phase-1 probe for both contexts. Phase-2's `$N::inet[]`
      // parameter is the row set returned by phase-1 — not a value
      // derivable from static context — so phase-2 cannot be a pure
      // `buildParams(ctx)` entry without this prefetch. The result
      // is deduped per `Set` semantics inside `runPhase1Probe`.
      r3CandidateAssets = await probeR3CandidateAssets(probePool, {
        memberScanStartIso,
        memberScanEndIso,
      });
    } finally {
      await probePool.end();
    }
  }

  const ctx = {
    periodStartIso,
    periodEndIso,
    observedFromIso,
    addresses,
    memberScanStartIso,
    memberScanEndIso,
    r3CandidateAssets,
  };

  // Partition MEASURED_QUERIES by measurability against `ctx`. A
  // phase-2 (query, context) whose phase-1 probe returned zero
  // assets becomes a `notMeasurable` entry — no sample row, just a
  // meta record per the issue #601 contract.
  const { measurable, notMeasurable } = partitionMeasurableQueries(
    MEASURED_QUERIES,
    ctx,
  );
  for (const entry of notMeasurable) {
    process.stderr.write(
      `[measure-baseline-read-path] not measurable: ${entry.query}:${entry.context} — ${entry.reason}\n`,
    );
  }

  // Cold phase (AFTER the probe pool closes, BEFORE the measurement
  // pool opens). Re-runs `--cold-command` on a fresh `pg.Pool` for
  // each measured query so every cold sample observes a genuinely
  // cold cache — running the cold command once would warm the cache
  // for queries 2..N. See `runColdPhase` for the atomic-failure
  // contract: any cold-command failure yields zero cold samples,
  // never a partial mix.
  const cold = await runColdPhase({
    coldCommand: args.coldCommand,
    queries: measurable,
    ctx,
    makePool: () => new pg.Pool({ connectionString: args.connectionString }),
  });

  const pool = new pg.Pool({ connectionString: args.connectionString });
  try {
    const client = await pool.connect();
    try {
      const allSamples = [...cold.samples];
      const explainByQuery = {};

      // The queries share the connection and must run serially so
      // the planner cache state stays comparable across queries
      // within a run. `explainByQuery` is keyed by
      // `"<name>:<context>"` because the same query name appears
      // under multiple contexts (#601).
      for (const query of measurable) {
        const { samples, verbosePlan } = await measureQuery(
          client,
          query,
          ctx,
          args.warmups,
          args.samples,
        );
        allSamples.push(...samples);
        explainByQuery[formatQueryLabel(query)] = verbosePlan;
      }

      const meta = {
        connectionString: redactDsn(args.connectionString),
        window: args.window,
        periodStartIso,
        periodEndIso,
        observedFromIso,
        memberScanStartIso,
        memberScanEndIso,
        storyFinalizedThroughIso:
          storyFinalizedThroughMs === null
            ? null
            : new Date(storyFinalizedThroughMs).toISOString(),
        r3CandidateAssetCounts: {
          firstTick: r3CandidateAssets.firstTick.length,
          slopReplay: r3CandidateAssets.slopReplay.length,
        },
        warmups: args.warmups,
        samples: args.samples,
        coldReading: cold.label,
        addressSampleSize: addresses.length,
        menuCandidatesPerBucket: MENU_CANDIDATES_PER_BUCKET,
        notMeasurable,
        explainByQuery,
      };

      if (args.output === "tsv") {
        emitTsv(meta, allSamples);
      } else {
        emitJson(meta, allSamples);
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
  return 0;
}

/**
 * Drop the password segment of a DSN before echoing it into the
 * harness output. The output is meant for paste-into-PR review and
 * should never carry a credential.
 */
export function redactDsn(dsn) {
  try {
    const url = new URL(dsn);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return "<unparseable-dsn>";
  }
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`${err?.stack ?? err}\n`);
      process.exit(1);
    });
}
