import "server-only";

/**
 * Triage baseline force-rebuild (#473) — admin-only escape hatch out
 * of the natural-expiry default for corpus A.
 *
 * For a single customer-tenant DB and a single `[from, to)` window:
 *
 *   1. Acquire the per-customer session-level advisory lock — byte-
 *      identical key to cadence and exclusion-ADD, so all three
 *      writers serialize on the same `hashtext()` lock id.
 *   2. Page-fetch the upstream `eventListWithTriage` resolver bounded
 *      by `filter.start` / `filter.end` — NO db transaction is held
 *      across the network I/O.
 *   3. In one DB transaction: DELETE the existing corpus rows in
 *      `[from, to)`, INSERT the fresh `observed_event_meta` +
 *      `baseline_triaged_event` rows from the in-memory accumulator,
 *      UPDATE `baseline_corpus_state.last_rebuild_at`.
 *   4. Release the advisory lock (finally block).
 *
 * Returns row counts + duration + non-fatal warnings. Throws
 * {@link RebuildBusyError} when the lock cannot be acquired and
 * {@link RebuildTimeoutError} when the 300 s wall-clock cap fires.
 */

import type pg from "pg";

import {
  buildBaselineRefreshPayloads,
  loadBaselineRefreshRows,
  logSubdivideWarnings,
} from "@/lib/aimer/phase2/payload-builders";
import { enqueueNotice } from "@/lib/aimer/phase2/state";
import type { ActiveExclusionSetResolver } from "@/lib/triage/exclusion";
import { STORAGE_EXCLUSION_SET_RESOLVER } from "@/lib/triage/exclusion/active-set-storage";
import type { ActiveExclusionSet } from "@/lib/triage/exclusion/types";
import { getCustomerPool } from "@/lib/triage/policy/customer-db";

import { PHASE_1B_BASELINE_VERSION } from "./cadence";
import {
  type CadenceConnectionResponse,
  fetchEventPage,
  processFetchedPage,
  REVIEW_MAX_PAGE_SIZE,
} from "./pager";

/**
 * Maximum wall-clock duration a rebuild may consume, end-to-end
 * (auth → lock release). The handler enforces this and returns
 * `RebuildTimeout` to the caller; the operator must split the period
 * if a single rebuild legitimately takes longer.
 */
export const REBUILD_HARD_TIMEOUT_MS = 300_000;

/**
 * Page size cap for the rebuild's `eventListWithTriage` paginated
 * fetch. Mirrors the cadence pager's default — `review-web`'s
 * `Connection::pagination_input` rejects `first` outside `[0, 100]`.
 */
const REBUILD_PAGE_SIZE = REVIEW_MAX_PAGE_SIZE;

/**
 * Defense against a resolver that reports `hasNextPage = true`
 * indefinitely for an unbounded period. With 100 events per page,
 * 10 000 pages covers a million events — well above any sane
 * single-period rebuild.
 */
const REBUILD_MAX_PAGES = 10_000;

export class RebuildBusyError extends Error {
  constructor() {
    super(
      "Per-customer cadence advisory lock is held; cadence or another rebuild is currently writing for this customer.",
    );
    this.name = "RebuildBusyError";
  }
}

export class RebuildTimeoutError extends Error {
  constructor() {
    super("Rebuild exceeded the 300s hard timeout.");
    this.name = "RebuildTimeoutError";
  }
}

/**
 * The upstream resolver kept reporting `hasNextPage = true` after
 * the rebuild had fetched {@link REBUILD_MAX_PAGES} pages. Rather
 * than DELETE the period and INSERT only the capped first slice
 * (silent partial rebuild = data loss), the rebuild aborts before
 * the transaction starts. The operator should split the period and
 * retry, or investigate the resolver if the page count is unexpected
 * for the range.
 */
export class RebuildIncompleteError extends Error {
  readonly pagesFetched: number;
  constructor(pagesFetched: number) {
    super(
      `Rebuild fetched ${pagesFetched} pages from review without exhausting the range; refusing to DELETE/INSERT a partial corpus. Split the period and retry.`,
    );
    this.name = "RebuildIncompleteError";
    this.pagesFetched = pagesFetched;
  }
}

export interface RebuildResult {
  deletedTriagedRows: number;
  deletedObservedRows: number;
  insertedTriagedRows: number;
  insertedObservedRows: number;
  durationMs: number;
  /**
   * ISO-8601 wall-clock timestamp at which the rebuild handler started
   * (auth, lock acquire, fetch — i.e. the same anchor `durationMs`
   * measures from). Surfaced so the audit row's `details` block can
   * record an explicit `startedAt` rather than forcing readers to
   * back-compute it from `completedAt - durationMs`, matching the
   * audit payload spec in #473's operational sequence §6.
   */
  startedAtIso: string;
  /**
   * ISO-8601 wall-clock timestamp at the end of the rebuild (lock
   * release). The audit row records the explicit `completedAt` so the
   * post-hoc record carries both endpoints of the rebuild window — the
   * operator can correlate the audit entry against external incident
   * timelines without re-deriving the timestamp from durationMs.
   */
  completedAtIso: string;
  warnings: string[];
}

export interface RebuildInput {
  customerId: number;
  /** Inclusive ISO-8601 timestamp. */
  fromIso: string;
  /** Exclusive ISO-8601 timestamp; the range is half-open `[from, to)`. */
  toIso: string;
  /** Optional abort signal. */
  signal?: AbortSignal;
  /**
   * Test override of the upstream resolver. Production callers pass
   * `undefined`; the default storage-backed resolver loads the active
   * exclusion set from the tenant DB so the rebuild reflects the
   * current — not original — exclusion configuration.
   */
  testOverrides?: {
    fetchPage?: (args: {
      customerId: number;
      variables: {
        filter: { customers: string[]; start?: string; end?: string };
        triage: null;
        first: number;
        after: string | null;
      };
      signal?: AbortSignal;
    }) => Promise<CadenceConnectionResponse>;
  };
}

import { LOCK_NAMESPACE } from "./cadence";

interface AccumulatedPage {
  responses: CadenceConnectionResponse[];
  /** True once at least one fetched page returned zero edges. */
  observedEmpty: boolean;
}

/**
 * Acquire the per-customer session-level advisory lock. The session
 * scope is critical — the rebuild does network I/O (the `review`
 * fetch) **outside** the DB transaction, so a transaction-scoped
 * lock would not bridge that fetch. The lock release is wired up in
 * the caller's `finally` block.
 *
 * Uses the byte-identical key (`triage_baseline_cadence:<id>`) that
 * cadence and exclusion-ADD use, so all three writers contend on the
 * same `hashtext()` lock id.
 */
async function acquireSessionLock(
  client: pg.PoolClient,
  customerId: number,
): Promise<boolean> {
  const { rows } = await client.query<{ acquired: boolean }>(
    `SELECT pg_try_advisory_lock(hashtext($1)) AS acquired`,
    [`${LOCK_NAMESPACE}${customerId}`],
  );
  return rows[0]?.acquired === true;
}

async function releaseSessionLock(
  client: pg.PoolClient,
  customerId: number,
): Promise<void> {
  try {
    await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [
      `${LOCK_NAMESPACE}${customerId}`,
    ]);
  } catch {
    // Lock is also implicitly released on connection close; failing
    // to issue the explicit unlock is not a correctness issue.
  }
}

/**
 * Run the full rebuild for a single customer / `[from, to)` window.
 *
 * On success returns counts + duration + warnings; on a 300 s timeout
 * throws {@link RebuildTimeoutError}; on lock unavailability throws
 * {@link RebuildBusyError}. All other failures propagate the
 * underlying error and roll back the rebuild's DB transaction; the
 * pre-rebuild row set is preserved because DELETE + INSERT share one
 * atomic transaction.
 */
export async function runTriageBaselineRebuild(
  input: RebuildInput,
): Promise<RebuildResult> {
  const startedAt = Date.now();
  const warnings: string[] = [];

  const pool = await getCustomerPool(input.customerId);
  const client = await pool.connect();

  // Wall-clock deadline. Used to short-circuit the fetch loop and
  // to fail fast if the deadline is hit mid-DB-transaction.
  const deadline = startedAt + REBUILD_HARD_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(REBUILD_HARD_TIMEOUT_MS);
  const combinedSignal = input.signal
    ? anySignal([input.signal, timeoutSignal])
    : timeoutSignal;

  let acquired = false;
  let counts: Omit<
    RebuildResult,
    "durationMs" | "warnings" | "startedAtIso" | "completedAtIso"
  >;
  try {
    // (a) Acquire the per-customer session-level advisory lock first.
    // Cadence and exclusion-ADD also contend on this key, so once it
    // is held no concurrent writer can commit a new exclusion row
    // until the rebuild releases the lock.
    acquired = await acquireSessionLock(client, input.customerId);
    if (!acquired) {
      // The `finally` block below releases the pool client; releasing
      // here would double-release (pg throws on the second release()
      // and that error replaces the RebuildBusyError on the way out).
      throw new RebuildBusyError();
    }

    // (b) Resolve the active exclusion set **after** the lock is held.
    //
    // Round 5 P1: doing the resolve before the lock leaves a window in
    // which an exclusion-ADD can commit (acquires the same key via
    // `pg_advisory_xact_lock`) between the snapshot and the rebuild
    // taking the lock. The rebuild would then DELETE the period and
    // re-INSERT with the stale pre-ADD exclusion set, reintroducing
    // rows the just-committed exclusion was supposed to remove. The
    // shared-lock contract requires the snapshot to be observed inside
    // the same held-lock region as the DELETE/INSERT chain, so any
    // exclusion-ADD attempt after this point waits for the rebuild to
    // release the lock and acts on the rebuilt corpus instead of being
    // overwritten by it.
    //
    // The storage resolver issues SELECTs on pool connections the
    // rebuild's transaction client does not own, so `SET LOCAL
    // statement_timeout` cannot govern them. The wall-clock contract
    // is preserved instead by racing the resolve against the rebuild's
    // 300 s deadline (see {@link resolveActiveExclusionsWithDeadline}):
    // if the deadline lapses first, the caller throws
    // `RebuildTimeoutError`, the `finally` block releases the advisory
    // lock, and cadence / exclusion-ADD become un-blocked within the
    // budget. The underlying SELECT keeps running on its own pool
    // connection but no longer affects the lock.
    //
    // Pinning the exclusion set once up-front (rather than re-resolving
    // per page) also guarantees every page of the rebuild matches
    // against the same snapshot — there can be no drifting
    // `exclusions_fp` between pages of one rebuild.
    const activeExclusions = await resolveActiveExclusionsWithDeadline(
      input.customerId,
      deadline,
    );
    const fixedResolver = createFixedExclusionResolver(activeExclusions);

    // (b) Fetch all pages bounded by `[from, to)` from review.
    // Network I/O outside of any DB transaction.
    const fetchedPages = await fetchAllPagesInRange(
      input.customerId,
      input.fromIso,
      input.toIso,
      combinedSignal,
      timeoutSignal,
      input.testOverrides?.fetchPage,
      deadline,
    );
    if (fetchedPages.observedEmpty) {
      warnings.push(
        "review returned 0 events in range; corpus is now empty for [from, to)",
      );
    }

    if (Date.now() > deadline) {
      throw new RebuildTimeoutError();
    }

    // (b) Single DB transaction: DELETE + INSERT + UPDATE corpus state.
    // Every SQL statement issued inside the transaction goes through a
    // deadline-aware client wrapper that re-binds
    // `SET LOCAL statement_timeout = <remaining-ms>` before each
    // round-trip — see {@link createDeadlineBoundClient}. The post-
    // flight `isStatementTimeoutError` mapping converts the Postgres
    // 57014 cancel into a typed `RebuildTimeoutError`.
    try {
      counts = await runRebuildTransaction(client, input, fetchedPages, {
        signal: combinedSignal,
        deadline,
        resolver: fixedResolver,
      });
    } catch (err) {
      if (Date.now() > deadline || isStatementTimeoutError(err)) {
        throw new RebuildTimeoutError();
      }
      throw err;
    }
  } finally {
    if (acquired) {
      await releaseSessionLock(client, input.customerId);
    }
    client.release();
  }

  // Capture `completedAt` **after** the `finally` block has executed
  // `pg_advisory_unlock` + `client.release()`, so `durationMs` /
  // `completedAtIso` reflect the actual lock-release boundary
  // (#473's operational sequence §6: `durationMs` is end-to-end wall
  // time through lock release, and the audit row's `completedAt` must
  // not mark the rebuild done before cadence / exclusion-ADD are
  // actually un-blocked on the shared key). Capturing inside the
  // `try` (before the unlock round-trip) would under-report the
  // window by the unlock latency.
  const completedAt = Date.now();
  return {
    ...counts,
    durationMs: completedAt - startedAt,
    startedAtIso: new Date(startedAt).toISOString(),
    completedAtIso: new Date(completedAt).toISOString(),
    warnings,
  };
}

async function fetchAllPagesInRange(
  customerId: number,
  fromIso: string,
  toIso: string,
  signal: AbortSignal,
  timeoutSignal: AbortSignal,
  fetchOverride:
    | ((args: {
        customerId: number;
        variables: {
          filter: { customers: string[]; start?: string; end?: string };
          triage: null;
          first: number;
          after: string | null;
        };
        signal?: AbortSignal;
      }) => Promise<CadenceConnectionResponse>)
    | undefined,
  deadline: number,
): Promise<AccumulatedPage> {
  const fetcher = fetchOverride ?? fetchEventPage;
  const responses: CadenceConnectionResponse[] = [];
  let after: string | null = null;
  let observedEmpty = false;

  for (let page = 0; page < REBUILD_MAX_PAGES; page += 1) {
    if (signal.aborted) {
      throw new RebuildTimeoutError();
    }
    if (Date.now() > deadline) {
      throw new RebuildTimeoutError();
    }
    let response: CadenceConnectionResponse;
    try {
      response = await fetcher({
        customerId,
        signal,
        variables: {
          filter: {
            customers: [String(customerId)],
            start: fromIso,
            end: toIso,
          },
          triage: null,
          first: REBUILD_PAGE_SIZE,
          after,
        },
      });
    } catch (err) {
      // The pre-fetch `signal.aborted` / `Date.now() > deadline` checks
      // above only catch aborts that fire **before** the fetch is
      // issued. If the rebuild's 300 s hard timer (`AbortSignal.timeout`)
      // fires while `fetcher()` / `graphqlRequest()` is in flight, the
      // underlying `fetch` rejects with an `AbortError` — not a
      // `RebuildTimeoutError` — and the route handler's
      // `instanceof RebuildTimeoutError` check would miss it, surfacing
      // the network-layer error as a generic 500 instead of the typed
      // `{ code: "RebuildTimeout" }` (504) the contract promises.
      //
      // Normalize: if an abort error lands while the deadline has
      // elapsed or the timeout signal is aborted, classify it as the
      // rebuild's own timeout. Caller-supplied `input.signal` aborts
      // that are not also past the deadline propagate as-is so the
      // operator-cancelled path is not mislabelled as a server-side
      // timeout.
      if (
        isAbortError(err) &&
        (Date.now() > deadline || timeoutSignal.aborted)
      ) {
        throw new RebuildTimeoutError();
      }
      throw err;
    }
    responses.push(response);
    const conn = response.eventListWithTriage;
    if (conn.edges.length === 0 && page === 0) {
      observedEmpty = true;
    }
    if (!conn.pageInfo.hasNextPage) {
      return { responses, observedEmpty };
    }
    if (conn.pageInfo.endCursor === null) {
      // The resolver reports there are more pages but does not give
      // a cursor to fetch them with. Continuing would either loop on
      // the same `after = null` request indefinitely or proceed with
      // the partial slice we already accumulated; both are wrong, and
      // committing the partial slice after the DELETE in step (b)
      // would erase the rest of the period. Refuse the rebuild before
      // the transaction begins so the corpus is left intact.
      throw new RebuildIncompleteError(page + 1);
    }
    after = conn.pageInfo.endCursor;
  }
  // Loop fell out without observing `hasNextPage = false`; the
  // resolver still has more rows. INSERTing only the capped slice
  // after the DELETE in step (b) would erase data, so abort before
  // the transaction begins.
  throw new RebuildIncompleteError(REBUILD_MAX_PAGES);
}

async function runRebuildTransaction(
  client: pg.PoolClient,
  input: RebuildInput,
  pages: AccumulatedPage,
  options: {
    signal: AbortSignal;
    deadline: number;
    resolver: ActiveExclusionSetResolver;
  },
): Promise<
  Omit<
    RebuildResult,
    "durationMs" | "warnings" | "startedAtIso" | "completedAtIso"
  >
> {
  // Wrap the pool client so every `query()` issued inside the
  // transaction is preceded by `SET LOCAL statement_timeout =
  // <remaining-ms>` and rejected client-side once the cumulative
  // wall-clock budget reaches zero. Used for the inner SQL inside
  // `processFetchedPage` — the helper calls `insertObservedEventMetaBatch`,
  // `detectActiveWindows`, `scoreSelectorsForPage`, and
  // `insertBaselineTriagedEventBatch` via the same `client.query()`
  // surface, and per-statement re-binding is required because
  // Postgres' `statement_timeout` resets per statement. The
  // transaction-control statements (BEGIN / COMMIT / ROLLBACK) stay
  // on the raw client so they are not preceded by a redundant SET.
  const deadlineClient = createDeadlineBoundClient(client, options.deadline);

  await client.query("BEGIN");
  try {
    // Postgres' `statement_timeout` is *per statement*, not cumulative
    // for the transaction. To enforce the rebuild's 300 s wall-clock
    // cap across the whole DELETE → INSERT chain, re-bind the timeout
    // to the *remaining* budget before every SQL statement (via
    // `runWithDeadline`). Once the cumulative budget reaches zero the
    // next statement is rejected client-side before being issued; any
    // long-running statement that overshoots the remaining budget is
    // aborted by Postgres with SQLSTATE 57014, which the outer caller
    // converts into `RebuildTimeoutError`. JS-side bookkeeping is
    // covered by the same deadline check.

    const deletedTriaged = await runWithDeadline<{ count: number }>(
      client,
      options.deadline,
      `WITH deleted AS (
         DELETE FROM baseline_triaged_event
          WHERE event_time >= $1 AND event_time < $2
        RETURNING 1
       )
       SELECT count(*)::int AS count FROM deleted`,
      [input.fromIso, input.toIso],
    );
    const deletedTriagedRows = deletedTriaged.rows[0]?.count ?? 0;

    const deletedObserved = await runWithDeadline<{ count: number }>(
      client,
      options.deadline,
      `WITH deleted AS (
         DELETE FROM observed_event_meta
          WHERE event_time >= $1 AND event_time < $2
        RETURNING 1
       )
       SELECT count(*)::int AS count FROM deleted`,
      [input.fromIso, input.toIso],
    );
    const deletedObservedRows = deletedObserved.rows[0]?.count ?? 0;

    let insertedObservedRows = 0;
    let insertedTriagedRows = 0;
    for (const response of pages.responses) {
      // Re-check the cumulative deadline at each page boundary; if it
      // has already lapsed, abort before issuing any of the per-page
      // SQL inside `processFetchedPage`. The page-boundary
      // `SET LOCAL` is a belt-and-suspenders cap that fires even when
      // a page has zero edges (so the helper issues no SQL of its
      // own) and is the visible boundary marker in tests that count
      // SET LOCALs at transaction granularity. The deadline-bound
      // `deadlineClient` wrapper *additionally* re-binds
      // `statement_timeout = <remaining>` before every internal
      // `client.query()` call (the observed/baseline INSERTs, the
      // active-windows SELECT, and the selector scoring SELECT inside
      // `processFetchedPage`) — Postgres' `statement_timeout` resets
      // per statement, so a single page-boundary bind is not enough
      // to cumulatively cap a helper that issues four sequential
      // statements. The per-statement re-bind via the proxy is what
      // makes the 300 s cap actually cumulative across helper
      // internals.
      const remainingMs = options.deadline - Date.now();
      if (remainingMs <= 0) {
        throw new RebuildTimeoutError();
      }
      await client.query(`SET LOCAL statement_timeout = ${remainingMs}`);
      const result = await processFetchedPage(
        deadlineClient,
        input.customerId,
        response,
        {
          resolver: options.resolver,
          signal: options.signal,
          // Cadence owns the story-finalization watermark; the rebuild
          // re-fills a historical window and must NOT advance it.
          runStoryCorrelator: false,
        },
      );
      insertedObservedRows += result.observedInserted;
      insertedTriagedRows += result.baselineInserted;
    }

    // Stamp the rebuild marker. The corpus-state singleton is keyed
    // by `id = true` and inserted by the cadence runner on first
    // run; INSERT here for completeness so a fresh-tenant rebuild
    // (cadence has not yet ticked) still records the marker.
    await runWithDeadline(
      client,
      options.deadline,
      `INSERT INTO baseline_corpus_state (id, last_rebuild_at)
            VALUES (true, NOW())
       ON CONFLICT (id) DO UPDATE
            SET last_rebuild_at = NOW()`,
    );

    // Per #573 Trigger 2: enqueue `refresh_baseline_window` notices
    // **inside** the rebuild transaction so a crash between COMMIT
    // and enqueue cannot leave the local rebuild durable but the
    // refresh notice never emitted. The drain is not run until the
    // next tab activation, by which point the rebuild is already
    // durable — so "the new authoritative content must exist locally
    // before aimer-web is told to replace" still holds. The payload
    // is sub-divided into adjacent half-open sub-windows whose
    // serialized JSON each fits PHASE2_REFRESH_PAYLOAD_MAX_BYTES.
    await enqueueRefreshBaselineWindow(client, input, options.deadline);

    // Final deadline check before COMMIT — covers JS-side bookkeeping
    // between the last `runWithDeadline` and publishing the
    // transaction.
    if (Date.now() > options.deadline) {
      throw new RebuildTimeoutError();
    }

    await client.query("COMMIT");
    return {
      deletedTriagedRows,
      deletedObservedRows,
      insertedTriagedRows,
      insertedObservedRows,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

/**
 * Read the freshly-INSERTed baseline rows back, build sub-divided
 * `refresh_baseline_window` payloads, and enqueue them on the rebuild
 * transaction's client so a rollback drops the notices with the
 * DELETE/INSERT (#573 Trigger 2).
 *
 * Empty windows emit one notice with an empty `events[]` array per
 * the sub-divider contract: aimer-web treats that as "replace the
 * window with nothing." The notice must still satisfy
 * `phase2.refresh_window.v1` / `phase2.backfill.v1`, which require a
 * non-empty `baseline_version`. Force Rebuild always writes
 * {@link PHASE_1B_BASELINE_VERSION} to the new corpus, so when the
 * rebuilt window happens to be empty we still attribute the notice to
 * that version — semantically, "the rebuild's chosen version says this
 * window is empty."
 */
async function enqueueRefreshBaselineWindow(
  client: pg.PoolClient,
  input: RebuildInput,
  deadline: number,
): Promise<void> {
  if (Date.now() > deadline) {
    throw new RebuildTimeoutError();
  }
  await client.query(`SET LOCAL statement_timeout = ${deadline - Date.now()}`);
  const { events, baselineVersion } = await loadBaselineRefreshRows(client, {
    fromIso: input.fromIso,
    toIso: input.toIso,
  });
  const { payloads, warnings } = buildBaselineRefreshPayloads({
    window: { from: input.fromIso, to: input.toIso },
    // `baseline_version` is absent only when the rebuild yielded zero
    // rows; fall back to the rebuild's target version so the empty
    // refresh notice still carries a non-empty discriminator the
    // signing schema requires.
    baselineVersion: baselineVersion ?? PHASE_1B_BASELINE_VERSION,
    events,
  });
  logSubdivideWarnings(input.customerId, "refresh_baseline_window", warnings);
  for (const payload of payloads) {
    if (Date.now() > deadline) {
      throw new RebuildTimeoutError();
    }
    await enqueueNotice(
      input.customerId,
      "refresh_baseline_window",
      payload,
      client,
    );
  }
}

/**
 * Run a single SQL statement inside the rebuild transaction with a
 * `statement_timeout` re-bound to the *remaining* wall-clock budget,
 * and a deadline check before the round-trip. The combination enforces
 * the 300 s hard cap cumulatively across the transaction:
 *
 *   - the JS-side check rejects new statements once the budget is
 *     exhausted (so an already-overrun transaction does not pile on
 *     more work);
 *   - the per-statement `SET LOCAL statement_timeout = <remaining>`
 *     lets Postgres abort any individual statement that would push
 *     the cumulative time past the cap (`SQLSTATE 57014`, which the
 *     outer caller converts to `RebuildTimeoutError`).
 *
 * `statement_timeout` alone is **not** cumulative: it resets for each
 * statement. Without this helper, a transaction could legitimately
 * spend `N × statement_timeout` of wall-clock and still commit.
 */
async function runWithDeadline<T extends pg.QueryResultRow = pg.QueryResultRow>(
  client: pg.PoolClient,
  deadline: number,
  sql: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new RebuildTimeoutError();
  }
  await client.query(`SET LOCAL statement_timeout = ${remainingMs}`);
  return (await client.query(sql, params)) as pg.QueryResult<T>;
}

/**
 * Wrap a {@link pg.PoolClient} so every `query()` issued through the
 * returned proxy is preceded by `SET LOCAL statement_timeout =
 * <remaining-ms>` and rejected client-side once the cumulative budget
 * reaches zero.
 *
 * Required because Postgres' `statement_timeout` is **per statement**:
 * setting it once at the top of the transaction lets a chain of N
 * statements each spend up to the original timeout, blowing through
 * the 300 s wall-clock cap. The proxy re-binds the remaining budget
 * before every statement and refuses to issue the round-trip once the
 * cumulative budget is exhausted — so a slow internal statement
 * inside `processFetchedPage` (resolver SELECTs, observed/baseline
 * INSERTs, active-windows SELECT, selector scoring SELECT) is aborted
 * by Postgres with SQLSTATE 57014 rather than getting silent extra
 * budget. The outer caller converts the cancel into
 * {@link RebuildTimeoutError}.
 *
 * Transaction-control calls (BEGIN / COMMIT / ROLLBACK) should be
 * issued via the **raw** client; the proxy is intended only for
 * statements that genuinely benefit from the per-statement timeout
 * binding, not for transaction-control round-trips that do not.
 */
function createDeadlineBoundClient(
  client: pg.PoolClient,
  deadline: number,
): pg.PoolClient {
  // The proxy forwards arbitrary arg shapes through pg.PoolClient.query,
  // which has multiple overloads (string + params, QueryConfig, callback
  // forms). `unknown[]` keeps the forwarding type-safe at the boundary
  // and the cast back to `pg.PoolClient` re-applies the typed surface.
  type AnyArgs = unknown[];
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "query") {
        return async (...args: AnyArgs) => {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) {
            throw new RebuildTimeoutError();
          }
          // Issue the SET LOCAL on the **raw** client to avoid
          // recursing through this proxy (which would otherwise
          // prepend a SET LOCAL before the SET LOCAL).
          await target.query(`SET LOCAL statement_timeout = ${remainingMs}`);
          // Forward through the underlying `query` exactly as called.
          return (
            target.query as unknown as (...a: AnyArgs) => Promise<unknown>
          ).apply(target, args);
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function"
        ? (value as (...a: AnyArgs) => unknown).bind(target)
        : value;
    },
  }) as pg.PoolClient;
}

/**
 * Resolve the active exclusion set with a hard wall-clock deadline.
 *
 * The storage resolver runs its global / per-tenant SELECTs on pool
 * connections that the rebuild's transaction client does not own, so
 * `SET LOCAL statement_timeout` cannot govern them. To keep a stuck
 * resolver from pushing the rebuild past the 300 s cap — and (since
 * the resolve runs *after* lock acquisition; see Round 5 P1 in
 * {@link runTriageBaselineRebuild}) from holding the per-customer
 * advisory lock past the cap — race the resolve against a JS-side
 * timer that rejects with {@link RebuildTimeoutError} if the deadline
 * lapses first. If the timer fires, the resolve's underlying SQL
 * keeps running on its own pool connection until it completes
 * naturally — but the rebuild's `finally` block releases the advisory
 * lock so cadence / exclusion-ADD become un-blocked within budget.
 */
async function resolveActiveExclusionsWithDeadline(
  customerId: number,
  deadline: number,
): Promise<ActiveExclusionSet> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new RebuildTimeoutError();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timerPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new RebuildTimeoutError());
      }, remainingMs);
      // Don't keep the Node event loop alive on the timer alone.
      (timer as unknown as { unref?: () => void }).unref?.();
    });
    return await Promise.race([
      STORAGE_EXCLUSION_SET_RESOLVER.resolve(customerId),
      timerPromise,
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Adapter that returns a pre-resolved {@link ActiveExclusionSet}
 * synchronously. Used so the rebuild can resolve the active exclusion
 * set **once outside** the BEGIN/COMMIT block (avoiding the storage
 * resolver's separate-connection SQL inside the transaction) and then
 * pin the same set across every page of the rebuild — so an
 * exclusion-ADD that landed mid-fetch does not produce a drifting
 * `exclusions_fp` between pages of one rebuild.
 */
function createFixedExclusionResolver(
  active: ActiveExclusionSet,
): ActiveExclusionSetResolver {
  return {
    async resolve(): Promise<ActiveExclusionSet> {
      return active;
    },
  };
}

/**
 * Detect errors caused by an `AbortSignal` firing on an in-flight
 * fetch. `undici` and `graphql-request` reject with a `DOMException` /
 * `Error` whose `name === "AbortError"`; some runtimes also tag it via
 * `code === "ABORT_ERR"`. Used by the rebuild fetch loop to normalize
 * an in-flight abort caused by the rebuild's own 300 s hard timer into
 * a typed `RebuildTimeoutError` rather than letting the raw network
 * error escape as an untyped 500.
 */
function isAbortError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const e = err as { name?: unknown; code?: unknown };
  return e.name === "AbortError" || e.code === "ABORT_ERR";
}

/**
 * Postgres returns SQLSTATE 57014 (`query_canceled`) when a
 * statement is aborted by `statement_timeout`. The `pg` driver
 * exposes the code as `err.code` on the thrown error.
 */
function isStatementTimeoutError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "57014"
  );
}

/**
 * Compose multiple `AbortSignal`s into one that aborts when any of
 * the inputs aborts. `AbortSignal.any` is Node 20+ and may not be
 * available in older runtimes; this trivial polyfill keeps the
 * rebuild path independent of the target Node version.
 */
function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  if (typeof (AbortSignal as unknown as { any?: unknown }).any === "function") {
    return (
      AbortSignal as unknown as {
        any(signals: readonly AbortSignal[]): AbortSignal;
      }
    ).any(signals);
  }
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      return controller.signal;
    }
    s.addEventListener(
      "abort",
      () => {
        controller.abort(s.reason);
      },
      { once: true },
    );
  }
  return controller.signal;
}

export const _testing = {
  acquireSessionLock,
  releaseSessionLock,
};
