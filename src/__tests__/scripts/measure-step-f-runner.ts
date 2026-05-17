/**
 * Wall-clock runner for Story step (f) and combined (d)+(e)+(f)
 * page-transaction latency (issue #602, RFC parent #535).
 *
 * Lives under `src/__tests__/scripts/` because it imports
 * `processFetchedPage` from `@/lib/triage/baseline/pager`, whose import
 * graph carries `import "server-only"` and other `@/`-aliased modules
 * that a plain-Node `scripts/<name>.mjs` invocation cannot resolve. The
 * surrounding Vitest config aliases `server-only` to an empty mock and
 * resolves `@/`, so the runner runs as a Vitest entrypoint (Option 1
 * per issue #602: `RUNNER_TENANT=… pnpm vitest run …runner.test.ts`).
 *
 * The runner extends the #524 menu-read-path measurement harness with
 * the per-page processing block production runs — twice per page, once
 * with the step-(f) toggle off and once on — so the (d)+(e) baseline
 * and the (d)+(e)+(f) treated reading come from the same code path.
 *
 * Permission requirements (operator-visible — see README on issue #602):
 *
 *   - `INSERT` on `observed_event_meta`, `baseline_triaged_event`,
 *     `event_group`, `event_group_member`.
 *   - `INSERT` on `exclusion_snapshot` and `baseline_version_snapshot`
 *     — `processFetchedPage` unconditionally records both snapshots
 *     (`INSERT … ON CONFLICT DO NOTHING` keyed on `fingerprint` and
 *     `version` respectively) before any `observed_event_meta` /
 *     `baseline_triaged_event` row in the page can reference them.
 *     The grants are required even when the snapshot row for the
 *     current fingerprint / version already exists, because the
 *     statement still has to be syntactically authorised before
 *     `ON CONFLICT DO NOTHING` short-circuits it.
 *   - `INSERT` on `baseline_corpus_state` — the runner always issues
 *     `INSERT INTO baseline_corpus_state (id) VALUES (true) ON CONFLICT
 *     (id) DO NOTHING` before the first fetch (mirroring cadence's
 *     first-page state setup), so the grant is required even on
 *     tenants whose singleton row already exists.
 *   - `UPDATE` on `baseline_corpus_state` covering every column the
 *     runner writes inside the outer transaction:
 *       * `story_finalized_through` — advanced by step (f) inside
 *         `processFetchedPage`.
 *       * `last_event_cursor` — mirrored from cadence's per-page
 *         `markOk` after the unrolled advance pass.
 *       * `last_ingested_at` — set to `NOW()` by the `markOk` mirror.
 *       * `corpus_activated_at` — `COALESCE`-set by the `markOk`
 *         mirror on first activation.
 *       * `baseline_version` — written to `PHASE_1B_BASELINE_VERSION`
 *         by the `markOk` mirror.
 *       * `exclusions_fp` — written to the active resolver's
 *         fingerprint by the `markOk` mirror.
 *       * `last_run_status` — `'running'` on entry, `'ok'` after each
 *         advance pass.
 *       * `last_error` — `NULL`-set by both the `markRunning` and
 *         `markOk` mirrors.
 *   - A connection that opens its own transactions (no PgBouncer
 *     transaction-pool interposing on the rollback boundary).
 *
 * Rollback-per-sample still needs those grants — `SAVEPOINT … ROLLBACK
 * TO SAVEPOINT` requires the writes to be syntactically authorised
 * before they are discarded. The final outer `ROLLBACK` then discards
 * every `baseline_corpus_state` write listed above, so post-run state
 * is byte-identical to pre-run state.
 *
 * Concurrency: the runner takes the same per-customer advisory lock
 * the cadence pager uses (`pg_try_advisory_xact_lock(hashtext(...))`
 * with the byte-identical `LOCK_NAMESPACE + customerId` key) on the
 * outer transaction. The lock is held for the full duration of the
 * run (potentially several minutes for a full tick × samples × two
 * toggle passes); this blocks concurrent cadence ticks and
 * exclusion-ADD on the tenant for the duration. Acceptable on a
 * staging-shape tenant where measurement is the only consumer.
 */

import type pg from "pg";

import {
  LOCK_NAMESPACE,
  PHASE_1B_BASELINE_VERSION,
} from "@/lib/triage/baseline/cadence";
import {
  type CadenceConnectionResponse,
  type CadenceFetchPageArgs,
  processFetchedPage,
} from "@/lib/triage/baseline/pager";
import type { ActiveExclusionSetResolver } from "@/lib/triage/exclusion";

/** Sample-row labels emitted in the JSON output. */
export type StepFSamplePhase = "baseline" | "treated" | "advance";

export interface StepFSampleRow {
  pageIndex: number;
  phase: StepFSamplePhase;
  sampleIndex: number;
  elapsedMs: number;
  observedInserted: number;
  baselineInserted: number;
}

export interface PerPageStats {
  pageIndex: number;
  rowCount: number;
  baseline: { p50: number; p95: number };
  treated: { p50: number; p95: number };
  /** Paired `(treated_j − baseline_j)` differences. */
  delta: { p50: number; p95: number };
}

export interface FullTickStats {
  baseline: { p50: number; p95: number };
  treated: { p50: number; p95: number };
  delta: { p50: number; p95: number };
}

export interface StepFRunnerOutput {
  meta: {
    customerId: number;
    samples: number;
    pageSize: number;
    pageCount: number;
    mode: "sampling-rollback";
    lockNamespace: string;
  };
  samples: StepFSampleRow[];
  perPage: PerPageStats[];
  fullTick: FullTickStats | null;
}

/**
 * Build the byte-identical advisory-lock key the cadence pager uses
 * (`triage_baseline_cadence:${customerId}`). Constructed here rather
 * than imported from `_testing` so the cadence module's test-only
 * surface stays test-only.
 */
export function buildLockKeyParam(customerId: number): string {
  return `${LOCK_NAMESPACE}${customerId}`;
}

/**
 * Thrown when the per-customer advisory lock is already held by
 * another writer at the start of a measurement run. The runner aborts
 * rather than measuring against a concurrent cadence / exclusion-ADD
 * run, which would invalidate the paired-sample variance assumption.
 */
export class LockNotAcquiredError extends Error {
  readonly customerId: number;
  constructor(customerId: number) {
    super(
      `measure-step-f: advisory lock already held for customer ${customerId} ` +
        "(competing cadence tick or exclusion-ADD in flight); refusing to " +
        "measure against a concurrent writer.",
    );
    this.name = "LockNotAcquiredError";
    this.customerId = customerId;
  }
}

/**
 * Minimal query-callable contract for {@link tryAcquireAdvisoryLock}.
 * Subset of `pg.PoolClient` chosen so the lock probe is independently
 * testable with a stub that exposes only `query` and does not need to
 * implement the full `pg.PoolClient` overload set. The row shape is
 * left as `unknown` here so the helper can narrow it itself.
 */
export interface LockProbeClient {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * Try the same `pg_try_advisory_xact_lock(hashtext($1))` call the
 * cadence pager uses, with the matching key. Caller is expected to
 * have already opened a transaction so the lock is transaction-scoped.
 */
export async function tryAcquireAdvisoryLock(
  client: LockProbeClient,
  customerId: number,
): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired`,
    [buildLockKeyParam(customerId)],
  );
  const first = rows[0] as { acquired?: unknown } | undefined;
  return first?.acquired === true;
}

/**
 * Subset of the cadence corpus-state row the runner needs to start
 * the page walk from the same cursor production cadence would. Kept
 * narrow on purpose — the runner only mirrors the columns that
 * influence the next page's behaviour (cursor) or are write-discarded
 * by the outer ROLLBACK and asserted on by the snapshot test.
 */
interface RunnerCorpusState {
  last_event_cursor: string | null;
}

/**
 * Mirror of cadence's `readOrInitCorpusState` so the runner picks up
 * the tenant's current watermark instead of replaying the entire
 * Review connection from the beginning. INSERTed inside the outer
 * transaction; the final outer ROLLBACK undoes both the INSERT (if
 * the singleton was absent) and the run-status UPDATEs below.
 *
 * Lives here, not as an import from `cadence.ts`, for the same reason
 * `buildLockKeyParam` is mirrored: `cadence.ts` keeps these helpers
 * private (or behind `_testing`) and the runner deliberately does not
 * widen that surface.
 */
export async function readOrInitRunnerCorpusState(
  client: pg.PoolClient,
): Promise<RunnerCorpusState> {
  await client.query(
    `INSERT INTO baseline_corpus_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING`,
  );
  const result = await client.query<RunnerCorpusState>(
    `SELECT last_event_cursor
       FROM baseline_corpus_state
      WHERE id = true`,
  );
  if (result.rows.length === 0) {
    throw new Error(
      "measure-step-f: baseline_corpus_state singleton row is missing after INSERT — this should be unreachable.",
    );
  }
  return result.rows[0];
}

/**
 * Mirror of cadence's `markRunning` so the advance pass exercises the
 * same UPDATE the operator's grants must cover. The write is discarded
 * by the outer ROLLBACK.
 */
export async function markRunnerStateRunning(
  client: pg.PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE baseline_corpus_state
        SET last_run_status = 'running',
            last_error = NULL
      WHERE id = true`,
  );
}

/**
 * Mirror of cadence's `markOk` so subsequent pages in the same
 * measurement see the same intra-tick `last_event_cursor` /
 * `exclusions_fp` / `last_ingested_at` advance production would
 * perform between page commits. Discarded by the outer ROLLBACK.
 */
export async function markRunnerStateOk(
  client: pg.PoolClient,
  endCursor: string | null,
  exclusionsFp: string,
): Promise<void> {
  await client.query(
    `UPDATE baseline_corpus_state
        SET last_run_status = 'ok',
            last_error = NULL,
            last_ingested_at = NOW(),
            corpus_activated_at = COALESCE(corpus_activated_at, NOW()),
            last_event_cursor = COALESCE($1, last_event_cursor),
            baseline_version = $2,
            exclusions_fp = $3
      WHERE id = true`,
    [endCursor, PHASE_1B_BASELINE_VERSION, exclusionsFp],
  );
}

/**
 * Linear-interpolation percentile. `p` is in `[0, 1]`. Empty input
 * returns `NaN`, matching the harness convention of letting the
 * consumer (the measurement comment) decide how to render an empty
 * cohort. The convention matches numpy's default `linear` percentile,
 * which is what the menu-read-path harness consumer uses on its
 * derived statistics.
 */
export function percentile(values: ReadonlyArray<number>, p: number): number {
  if (values.length === 0) return Number.NaN;
  if (values.length === 1) return values[0];
  const sorted = [...values].sort((a, b) => a - b);
  const idx = p * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  const frac = idx - lower;
  return sorted[lower] * (1 - frac) + sorted[upper] * frac;
}

/**
 * Pair `treated_j − baseline_j` element-wise so the paired-delta
 * percentiles cancel per-page noise that affects both halves of the
 * same `j`-th sample equally. Throws if the arrays disagree on length
 * — that would silently let the gate read independent percentiles
 * instead.
 */
export function pairedDeltas(
  baseline: ReadonlyArray<number>,
  treated: ReadonlyArray<number>,
): number[] {
  if (baseline.length !== treated.length) {
    throw new Error(
      `pairedDeltas: length mismatch (baseline=${baseline.length}, treated=${treated.length})`,
    );
  }
  const out: number[] = [];
  for (let i = 0; i < baseline.length; i++) {
    out.push(treated[i] - baseline[i]);
  }
  return out;
}

/**
 * Build the per-page statistics record from this page's two
 * measurement cohorts. `rowCount` is included so a single hot page is
 * recognizable in the per-page table even before the consumer looks at
 * the timing distribution.
 */
export function summarizePageSamples(
  pageIndex: number,
  rowCount: number,
  baselineMs: ReadonlyArray<number>,
  treatedMs: ReadonlyArray<number>,
): PerPageStats {
  const deltas = pairedDeltas(baselineMs, treatedMs);
  return {
    pageIndex,
    rowCount,
    baseline: {
      p50: percentile(baselineMs, 0.5),
      p95: percentile(baselineMs, 0.95),
    },
    treated: {
      p50: percentile(treatedMs, 0.5),
      p95: percentile(treatedMs, 0.95),
    },
    delta: {
      p50: percentile(deltas, 0.5),
      p95: percentile(deltas, 0.95),
    },
  };
}

/**
 * Aggregate the full-tick statistics by taking percentiles over the
 * per-page `p50`s. The full-tick `p95` is therefore the slowest
 * representative-page reading rather than an averaged tail, which is
 * what the gate needs to detect a single hot page hiding in the
 * distribution. Returns `null` when no pages were measured.
 */
export function summarizeFullTick(
  perPage: ReadonlyArray<PerPageStats>,
): FullTickStats | null {
  if (perPage.length === 0) return null;
  const baselineP50s = perPage.map((p) => p.baseline.p50);
  const treatedP50s = perPage.map((p) => p.treated.p50);
  const deltaP50s = perPage.map((p) => p.delta.p50);
  return {
    baseline: {
      p50: percentile(baselineP50s, 0.5),
      p95: percentile(baselineP50s, 0.95),
    },
    treated: {
      p50: percentile(treatedP50s, 0.5),
      p95: percentile(treatedP50s, 0.95),
    },
    delta: {
      p50: percentile(deltaP50s, 0.5),
      p95: percentile(deltaP50s, 0.95),
    },
  };
}

export type FetchEventPageFn = (
  args: CadenceFetchPageArgs,
) => Promise<CadenceConnectionResponse>;

export interface RunStepFMeasurementOptions {
  client: pg.PoolClient;
  customerId: number;
  /** Per-page sample count for each toggle pass. Defaults to 30. */
  samples?: number;
  /** Resolver feeding the cadence exclusion set. */
  resolver: ActiveExclusionSetResolver;
  /** GraphQL page-fetch function (defaults to `fetchEventPage`). */
  fetchPage: FetchEventPageFn;
  /** First-page size. Defaults to the cadence pager's default. */
  pageSize: number;
  /** Hard cap on pages walked. Mirrors cadence's `MAX_PAGES_PER_RUN`. */
  maxPages?: number;
  signal?: AbortSignal;
  /** Optional human-readable progress hook. */
  onProgress?: (msg: string) => void;
  /**
   * Wall-clock provider, injected for tests. Defaults to
   * `performance.now()`. The runner expects monotonic ms.
   */
  now?: () => number;
}

const DEFAULT_SAMPLES_PER_PAGE = 30;
const DEFAULT_MAX_PAGES = 200;

/**
 * Drive one full tick on the chosen tenant, taking `samples` per page
 * for each of the baseline (step-(f) off) and treated (step-(f) on)
 * code paths plus one advance pass that releases its savepoint so the
 * next page sees the same intra-tick state production would.
 *
 * The entire run sits inside one outer transaction; nothing is ever
 * committed, so the run leaves the tenant's `observed_event_meta`,
 * `baseline_triaged_event`, `event_group`, `event_group_member`, and
 * `baseline_corpus_state` rows byte-identical to the pre-run snapshot.
 */
export async function runStepFMeasurement(
  options: RunStepFMeasurementOptions,
): Promise<StepFRunnerOutput> {
  const {
    client,
    customerId,
    resolver,
    fetchPage,
    pageSize,
    signal,
    onProgress,
  } = options;
  const samples = options.samples ?? DEFAULT_SAMPLES_PER_PAGE;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const now = options.now ?? (() => performance.now());

  if (samples < 1) {
    throw new Error(
      `runStepFMeasurement: samples must be ≥ 1 (got ${samples})`,
    );
  }

  const sampleRows: StepFSampleRow[] = [];
  const perPage: PerPageStats[] = [];

  await client.query("BEGIN");
  try {
    const acquired = await tryAcquireAdvisoryLock(client, customerId);
    if (!acquired) {
      throw new LockNotAcquiredError(customerId);
    }

    // Mirror cadence's first-page state setup so the measurement
    // starts from the tenant's current `last_event_cursor` (not the
    // beginning of the Review connection) and the per-page advance
    // exercises the same `baseline_corpus_state` UPDATEs production
    // does. Both writes ride the outer transaction and are discarded
    // by the final ROLLBACK; the snapshot assertion verifies the
    // discard.
    const initialState = await readOrInitRunnerCorpusState(client);
    await markRunnerStateRunning(client);

    let afterCursor: string | null = initialState.last_event_cursor;
    let pageIndex = 0;
    let hasNextPage = true;

    while (hasNextPage && pageIndex < maxPages) {
      if (signal?.aborted) break;

      const fetched = await fetchPage({
        customerId,
        variables: {
          filter: { customers: [String(customerId)] },
          triage: null,
          first: pageSize,
          after: afterCursor,
        },
        signal,
      });
      const edges = fetched.eventListWithTriage.edges;
      if (edges.length === 0) {
        // Empty first page (and the resolver will not produce more on
        // a subsequent fetch from the same cursor): stop cleanly.
        if (!fetched.eventListWithTriage.pageInfo.hasNextPage) break;
        // Defensive: an unusual resolver that reports `hasNextPage`
        // with empty edges would loop forever; bail out.
        break;
      }

      onProgress?.(
        `page ${pageIndex}: ${edges.length} edges; sampling baseline×${samples}, treated×${samples}, advance×1`,
      );

      const baselineMs = await sampleToggleFor({
        client,
        fetched,
        resolver,
        signal,
        samples,
        runStoryCorrelator: false,
        spPrefix: `b_${pageIndex}`,
        now,
        sampleRows,
        pageIndex,
        phase: "baseline",
        customerId,
      });

      const treatedMs = await sampleToggleFor({
        client,
        fetched,
        resolver,
        signal,
        samples,
        runStoryCorrelator: true,
        spPrefix: `t_${pageIndex}`,
        now,
        sampleRows,
        pageIndex,
        phase: "treated",
        customerId,
      });

      // Advance pass — RELEASE (not ROLLBACK TO) so the next page sees
      // the same intra-tick state production would. The pass is still
      // wrapped in a savepoint so a thrown error here can be rolled
      // back to the page's starting state and surfaced cleanly to the
      // operator; on success the savepoint is released.
      const advanceSp = `a_${pageIndex}`;
      await client.query(`SAVEPOINT ${advanceSp}`);
      const advanceStart = now();
      let advanceResult: Awaited<ReturnType<typeof processFetchedPage>>;
      let advanceElapsed: number;
      try {
        advanceResult = await processFetchedPage(client, customerId, fetched, {
          resolver,
          signal,
          runStoryCorrelator: true,
        });
        advanceElapsed = now() - advanceStart;
        // Mirror cadence's per-page `markOk` so the next page's
        // `processFetchedPage` (and any future caller that reads the
        // singleton mid-tick, e.g. step (f)'s watermark) observes the
        // same intra-tick state production would. Runs inside the
        // advance pass's savepoint so a failure rolls back to the
        // page's starting state; on success it is RELEASEd along
        // with the rest of the advance pass and ultimately discarded
        // by the outer ROLLBACK.
        await markRunnerStateOk(
          client,
          advanceResult.endCursor,
          advanceResult.exclusionsFp,
        );
      } catch (err) {
        await client
          .query(`ROLLBACK TO SAVEPOINT ${advanceSp}`)
          .catch(() => {});
        await client.query(`RELEASE SAVEPOINT ${advanceSp}`).catch(() => {});
        throw err;
      }
      await client.query(`RELEASE SAVEPOINT ${advanceSp}`);
      sampleRows.push({
        pageIndex,
        phase: "advance",
        sampleIndex: 0,
        elapsedMs: advanceElapsed,
        observedInserted: advanceResult.observedInserted,
        baselineInserted: advanceResult.baselineInserted,
      });

      perPage.push(
        summarizePageSamples(pageIndex, edges.length, baselineMs, treatedMs),
      );

      afterCursor = advanceResult.endCursor;
      hasNextPage = advanceResult.hasNextPage;
      pageIndex += 1;
    }

    return {
      meta: {
        customerId,
        samples,
        pageSize,
        pageCount: perPage.length,
        mode: "sampling-rollback",
        lockNamespace: LOCK_NAMESPACE,
      },
      samples: sampleRows,
      perPage,
      fullTick: summarizeFullTick(perPage),
    };
  } finally {
    // Always roll back the outer transaction. Even if every per-page
    // step succeeded, the runner is purely a measurement driver — it
    // must not advance `last_event_cursor`, `story_finalized_through`,
    // or leave any `observed_event_meta` / `baseline_triaged_event`
    // / `event_group` / `event_group_member` rows behind.
    await client.query("ROLLBACK").catch(() => {});
  }
}

interface SampleToggleArgs {
  client: pg.PoolClient;
  customerId: number;
  fetched: CadenceConnectionResponse;
  resolver: ActiveExclusionSetResolver;
  signal: AbortSignal | undefined;
  samples: number;
  runStoryCorrelator: boolean;
  spPrefix: string;
  now: () => number;
  sampleRows: StepFSampleRow[];
  pageIndex: number;
  phase: StepFSamplePhase;
}

async function sampleToggleFor(args: SampleToggleArgs): Promise<number[]> {
  const {
    client,
    customerId,
    fetched,
    resolver,
    signal,
    samples,
    runStoryCorrelator,
    spPrefix,
    now,
    sampleRows,
    pageIndex,
    phase,
  } = args;
  const elapsedMs: number[] = [];
  for (let j = 0; j < samples; j++) {
    if (signal?.aborted) break;
    const sp = `${spPrefix}_${j}`;
    await client.query(`SAVEPOINT ${sp}`);
    const start = now();
    let result: Awaited<ReturnType<typeof processFetchedPage>>;
    try {
      result = await processFetchedPage(client, customerId, fetched, {
        resolver,
        signal,
        runStoryCorrelator,
      });
    } catch (err) {
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => {});
      await client.query(`RELEASE SAVEPOINT ${sp}`).catch(() => {});
      throw err;
    }
    const elapsed = now() - start;
    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    elapsedMs.push(elapsed);
    sampleRows.push({
      pageIndex,
      phase,
      sampleIndex: j,
      elapsedMs: elapsed,
      observedInserted: result.observedInserted,
      baselineInserted: result.baselineInserted,
    });
  }
  return elapsedMs;
}
