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
// present, the harness runs the supplied shell command once before
// each window's warm-up batch and labels the run `"cold reading:
// captured via --cold-command=…"`. When absent, the harness records
// `"cold reading: not available — host policy"` and proceeds straight
// to warm-up; it never restarts Postgres or drops OS caches on its own
// because those operations are destructive on a shared staging DB.
// Connection drop/recreate is NOT cold (shared buffers and OS cache
// survive) and `pg_prewarm` is warm-side tooling — neither is used as
// a cold-cache approximation.
//
// Typical local-only `--cold-command` value (Linux dev box):
//   --cold-command="sudo systemctl restart postgresql && \
//                   sudo sync && \
//                   sudo sh -c 'echo 3 > /proc/sys/vm/drop_caches'"
// Whatever value the operator passes must be recorded in the #528 PR
// so the cold environment is auditable.
//
// Per query, per window: 5 warm-up runs (timings discarded) + 30 sample
// runs back-to-back against the same connection. `EXPLAIN (ANALYZE,
// BUFFERS, VERBOSE)` is captured on the first warm-sample run.
//
// Output
// ------
//
// Default JSON to stdout. One top-level object with `meta` (run config,
// resolved window, cold-reading label) and `samples` (one row per
// query × sample). `--output=tsv` emits a tab-separated table with
// columns: query, sample_index, elapsed_ms. The structured-JSON shape
// is the canonical form #528 consumes; TSV is a convenience for ad-hoc
// inspection.
//
// Sample row (JSON):
//   { "query": "selectMenuCohort", "sampleIndex": 0,
//     "elapsedMs": 18.42, "rowCount": 1837 }
//
// `EXPLAIN` plans live under `meta.explainByQuery`, keyed by query
// name. The harness emits the raw multi-line plan text; #528's
// consumer is expected to pretty-print or summarize as it sees fit.
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
//
// `--skip-profile-assert` exists as a developer escape hatch when
// running the harness against synthetic fixtures during script
// development. Production / staging runs MUST NOT pass this flag — the
// #528 measurement campaign assumes a profile-conformant tenant.

import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import pg from "pg";

import {
  MEASURED_QUERIES,
  MENU_CANDIDATES_PER_BUCKET,
} from "../src/lib/triage/baseline/read-path-sql.mjs";
import {
  assertRepresentativeProfile,
  formatProfileAssertionFailure,
  ProfileAssertionError,
} from "./measure-baseline-read-path/profile.mjs";

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
 * Run the operator-supplied cold command (if any) before the warm-up
 * batch. Returns the label that travels into the harness output so the
 * consumer can record the cold environment without re-running the
 * command. Best-effort and non-gating: a non-zero exit still proceeds
 * to warm-up but flags the label so #528 sees the failure mode.
 */
function runColdCommand(cmd) {
  if (cmd === null || cmd === undefined) {
    return "cold reading: not available — host policy";
  }
  const result = spawnSync(cmd, { shell: true, stdio: "inherit" });
  if (result.status === 0) {
    return `cold reading: captured via --cold-command=${JSON.stringify(cmd)}`;
  }
  return (
    `cold reading: --cold-command=${JSON.stringify(cmd)} exited ` +
    `${result.status ?? "<signal>"}, treated as warm`
  );
}

/**
 * Pick a small sample of distinct addresses from the cohort the menu
 * actually produces. The address-driven queries (`perAssetObservedCounts`,
 * `selectAssetDetailEventsBatch`) operate on the per-asset page; the
 * representative size in production is `TRIAGE_ASSET_PAGE_SIZE = 100`,
 * but the production path uses only addresses that actually appear in
 * the cohort. Sampling from the cohort here keeps the planner's row
 * estimates aligned with what production sees.
 */
async function sampleAddresses(pool, periodStartIso, periodEndIso, limit) {
  const { rows } = await pool.query(
    `SELECT DISTINCT orig_addr::text AS address
       FROM baseline_triaged_event
      WHERE event_time >= $1
        AND event_time <  $2
        AND orig_addr IS NOT NULL
      ORDER BY orig_addr
      LIMIT $3`,
    [periodStartIso, periodEndIso, limit],
  );
  return rows.map((r) => r.address);
}

async function captureExplain(client, sql, params) {
  const { rows } = await client.query(
    `EXPLAIN (ANALYZE, BUFFERS, VERBOSE) ${sql}`,
    params,
  );
  return rows.map((r) => r["QUERY PLAN"]).join("\n");
}

async function timedQuery(client, sql, params) {
  const start = performance.now();
  const { rowCount } = await client.query(sql, params);
  const elapsedMs = performance.now() - start;
  return { elapsedMs, rowCount: rowCount ?? 0 };
}

async function measureQuery(client, query, ctx, warmups, samples) {
  const params = query.buildParams(ctx);
  for (let i = 0; i < warmups; i++) {
    await client.query(query.sql, params);
  }
  const explainPlan = await captureExplain(client, query.sql, params);
  const queryRows = [];
  // Samples run serially against the same connection — concurrent
  // execution would invalidate the per-query timing.
  for (let i = 0; i < samples; i++) {
    const { elapsedMs, rowCount } = await timedQuery(client, query.sql, params);
    queryRows.push({
      query: query.name,
      sampleIndex: i,
      elapsedMs,
      rowCount,
    });
  }
  return { samples: queryRows, explainPlan };
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
  process.stdout.write("query\tsample_index\telapsed_ms\trow_count\n");
  for (const r of samples) {
    process.stdout.write(
      `${r.query}\t${r.sampleIndex}\t${r.elapsedMs.toFixed(3)}\t${r.rowCount}\n`,
    );
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  const { periodStartIso, periodEndIso } = resolveWindow(args.window);
  // `observedFromIso` matches the production formula in
  // `server-actions.ts`: `max(periodStart, now() - retention)`. The
  // retention floor is hard-coded to 30 days here to mirror the
  // production constant; if it changes there, update this comment and
  // the matching value below.
  const retentionMs = 30 * 24 * 60 * 60 * 1000;
  const observedFromMs = Math.max(
    Date.parse(periodStartIso),
    Date.now() - retentionMs,
  );
  const observedFromIso = new Date(observedFromMs).toISOString();

  const pool = new pg.Pool({ connectionString: args.connectionString });
  try {
    if (!args.skipProfileAssert) {
      try {
        await assertRepresentativeProfile(pool);
      } catch (err) {
        if (err instanceof ProfileAssertionError) {
          process.stderr.write(formatProfileAssertionFailure(err));
          process.stderr.write("\n");
          return 2;
        }
        throw err;
      }
    }

    // Sample at most 100 addresses (matches `TRIAGE_ASSET_PAGE_SIZE`)
    // so the per-asset queries plan against the same input size
    // production would feed them.
    const addresses = await sampleAddresses(
      pool,
      periodStartIso,
      periodEndIso,
      100,
    );

    const ctx = {
      periodStartIso,
      periodEndIso,
      observedFromIso,
      addresses,
    };

    const coldLabel = runColdCommand(args.coldCommand);

    const client = await pool.connect();
    try {
      const allSamples = [];
      const explainByQuery = {};
      // The queries share the connection and must run serially so the
      // planner cache state stays comparable across queries within a run.
      for (const query of MEASURED_QUERIES) {
        const { samples, explainPlan } = await measureQuery(
          client,
          query,
          ctx,
          args.warmups,
          args.samples,
        );
        allSamples.push(...samples);
        explainByQuery[query.name] = explainPlan;
      }

      const meta = {
        connectionString: redactDsn(args.connectionString),
        window: args.window,
        periodStartIso,
        periodEndIso,
        observedFromIso,
        warmups: args.warmups,
        samples: args.samples,
        coldReading: coldLabel,
        addressSampleSize: addresses.length,
        menuCandidatesPerBucket: MENU_CANDIDATES_PER_BUCKET,
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
