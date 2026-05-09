import "server-only";

/**
 * Triage baseline cadence runner (1B-1 / discussion #447 §3.4).
 *
 * Drives one ingestion pass for a single customer-tenant DB. The
 * deployment scheduler hits the internal route
 * (`POST /api/internal/triage/baseline/cadence`) once per hour per
 * customer; the route handler defers to {@link runTriageBaselineCadence}.
 *
 * ## Concurrency
 *
 * A second concurrent invocation for the same customer must not double-
 * ingest. The runner takes a per-customer transaction-scoped advisory
 * lock as the first statement of the cadence transaction:
 *
 *   `pg_try_advisory_xact_lock(hashtext('triage_baseline_cadence:' || customer_id))`
 *
 * If the lock is unavailable the runner exits cleanly without touching
 * `baseline_corpus_state` — the next scheduled tick picks up where the
 * previous run stopped via `last_event_cursor`. Lock release is
 * automatic on commit/rollback because it is transaction-scoped.
 *
 * ## Pipeline (per page)
 *
 *   a. Fetch a raw standard-filter page from review via
 *      `eventListWithTriage(triage = null)` (review-web#842).
 *   b. Populate normalized columns (host / dns_query / uri / etc.) per
 *      event-kind mapping.
 *   c. Apply active global + customer-scoped exclusions in-memory
 *      against the normalized columns with full semantics — IpAddress
 *      (CIDR containment), Hostname (exact), Uri (exact), Domain
 *      (RegexSet against host + dns_query only).
 *   d. INSERT remaining events into `observed_event_meta`.
 *   e. INSERT the baseline-passing subset into `baseline_triaged_event`.
 *   f. UPDATE `baseline_corpus_state.last_event_cursor` and
 *      `last_ingested_at`.
 *
 * Steps (d), (e), and (f) commit as a single transaction so the
 * watermark advances atomically with the rows it covers. PK collisions
 * on re-ingest of the same `event_key` are handled with
 * `ON CONFLICT DO NOTHING`.
 *
 * ## Upstream dependency
 *
 * This module ships the scheduler entrypoint, the advisory lock
 * discipline, the corpus-state machine, and the schema migration. The
 * GraphQL fetch-and-ingest path is intentionally a placeholder: it
 * depends on `eventListWithTriage` from aicers/review-web#842, which
 * exposes both the new `EventStandardFilterInput` filter type and the
 * `event_key` (i128 RocksDB primary key) selection that this corpus
 * keys on. Today's vendored `schemas/review.graphql` carries neither.
 *
 * Once #842 lands, the placeholder marker in {@link ingestPage} flips
 * to a real GraphQL pager: the rest of the cadence flow (lock,
 * transaction, status updates, normalization helpers, exclusion re-
 * application, ON CONFLICT DO NOTHING inserts, watermark advance) is
 * unchanged. The route handler and its token guard are unaffected.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import type pg from "pg";

import { getCustomerPool } from "@/lib/triage/policy/customer-db";

/**
 * Phase 1.A baseline-version marker stamped on every row this runner
 * inserts into `baseline_triaged_event`. The 1B-3 menu reader uses the
 * marker to distinguish Phase 1.A simple-rule rows from later 1B-8
 * four-selector rows, so a future cadence-version bump cleanly tags
 * its own output without disturbing rows already on disk. See
 * "What 'baseline-passing' means in 1B-1" in the issue body.
 */
export const PHASE_1A_BASELINE_VERSION = "phase1a-simple";

/**
 * Selector tag stamped on every Phase 1.A row. Stored as a
 * single-element TEXT[] so 1B-8 can extend the array without rewriting
 * existing rows.
 */
export const PHASE_1A_SELECTOR_TAG = "phase1a-simple";

/**
 * Constant placeholder score for Phase 1.A rows. Reflects "passed the
 * Phase 1.A simple rule"; replaced per-row by 1B-8's four-selector
 * scoring once that lands.
 */
export const PHASE_1A_BASELINE_SCORE = 1;

export type CadenceRunStatus = "ok" | "failed" | "running" | "skipped";

export interface CadenceRunResult {
  /** Customer the runner targeted. */
  customerId: number;
  /**
   * Outcome marker:
   *   - `ok`: the cadence transaction committed (zero or more pages
   *     ingested).
   *   - `skipped`: the per-customer advisory lock was unavailable
   *     because another run is in progress; this tick is a no-op.
   *   - `failed`: the cadence transaction rolled back; `error` carries
   *     the message that was persisted to
   *     `baseline_corpus_state.last_error`.
   *   - `running`: never returned to the caller — the on-disk marker
   *     used while a run holds the lock so a crash leaves a forensic
   *     breadcrumb.
   */
  status: Exclude<CadenceRunStatus, "running">;
  /** Number of rows inserted into `observed_event_meta` this run. */
  observedInserted: number;
  /** Number of rows inserted into `baseline_triaged_event` this run. */
  baselineInserted: number;
  /** End cursor from the last raw page successfully scanned this run. */
  lastEventCursor: string | null;
  /** Error message, populated only when `status === 'failed'`. */
  error?: string;
}

interface CorpusStateRow {
  last_ingested_at: Date | null;
  last_event_cursor: string | null;
  baseline_version: string | null;
  exclusions_fp: string | null;
  last_run_status: CadenceRunStatus | null;
  last_error: string | null;
}

/**
 * Build the bigint advisory-lock key. Mirrors the SQL formula in the
 * issue: `hashtext('triage_baseline_cadence:' || customer_id)`. Letting
 * the database compute the hash avoids a Node ↔ Postgres consistency
 * trap (Postgres' `hashtext` is not equivalent to any well-known JS
 * hash). Returns the raw SQL fragment passed straight into
 * `pg_try_advisory_xact_lock`.
 */
const LOCK_NAMESPACE = "triage_baseline_cadence:";

function buildLockKeyExpr(): string {
  return `hashtext($1)`;
}

function buildLockKeyParam(customerId: number): string {
  return `${LOCK_NAMESPACE}${customerId}`;
}

/**
 * Compute the canonical exclusions fingerprint placeholder. Phase 1.A
 * has no exclusions wired up (the helper from #460 / shared
 * `src/lib/triage/exclusion/` module has not landed yet); until then,
 * every Phase 1.A row carries a stable empty-set fingerprint so the
 * column is NOT NULL but does not falsely identify rows as having
 * passed any specific exclusion configuration. When #460 lands the
 * cadence runner swaps this constant for the real
 * `computeExclusionsFingerprint(active)` call.
 */
const EMPTY_EXCLUSIONS_FP = (() => {
  return createHash("sha256")
    .update("phase1a:no-exclusions", "utf8")
    .digest("hex");
})();

/**
 * Read the corpus-state row, INSERTing the singleton if it does not
 * yet exist. Mirrors the migration's `id BOOLEAN PRIMARY KEY` shape.
 */
async function readOrInitCorpusState(
  client: pg.PoolClient,
): Promise<CorpusStateRow> {
  await client.query(
    `INSERT INTO baseline_corpus_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING`,
  );
  const result = await client.query<CorpusStateRow>(
    `SELECT last_ingested_at, last_event_cursor, baseline_version,
            exclusions_fp, last_run_status, last_error
       FROM baseline_corpus_state
      WHERE id = true`,
  );
  if (result.rows.length === 0) {
    throw new Error(
      "baseline_corpus_state singleton row is missing after INSERT — this should be unreachable.",
    );
  }
  return result.rows[0];
}

async function markRunning(client: pg.PoolClient): Promise<void> {
  await client.query(
    `UPDATE baseline_corpus_state
        SET last_run_status = 'running',
            last_error = NULL
      WHERE id = true`,
  );
}

async function markOk(
  client: pg.PoolClient,
  endCursor: string | null,
  exclusionsFp: string,
): Promise<void> {
  await client.query(
    `UPDATE baseline_corpus_state
        SET last_run_status = 'ok',
            last_error = NULL,
            last_ingested_at = NOW(),
            last_event_cursor = COALESCE($1, last_event_cursor),
            baseline_version = $2,
            exclusions_fp = $3
      WHERE id = true`,
    [endCursor, PHASE_1A_BASELINE_VERSION, exclusionsFp],
  );
}

async function markFailed(pool: pg.Pool, message: string): Promise<void> {
  // Failure status is written *outside* the cadence transaction (which
  // rolled back) so the next scheduler tick can read it. Best-effort:
  // a failure recording itself is not allowed to mask the real error
  // the caller surfaces.
  try {
    await pool.query(
      `INSERT INTO baseline_corpus_state (id, last_run_status, last_error)
            VALUES (true, 'failed', $1)
       ON CONFLICT (id) DO UPDATE
            SET last_run_status = 'failed',
                last_error = EXCLUDED.last_error`,
      [message],
    );
  } catch {
    // Swallow: the original error is what matters; status persistence
    // is a forensic aid, not a correctness requirement.
  }
}

/**
 * Ingest a single page of standard-filter survivors and return the
 * count of rows inserted into each table plus the end cursor of the
 * page (or `null` if no further pages exist). Phase 1.A: this function
 * is a placeholder. The full implementation lands once review-web#842
 * exposes `eventListWithTriage` + `event_key`. Today it returns a
 * no-op page so the surrounding cadence transaction commits a clean
 * "ran, no work to do" record — the corpus stays empty until #842
 * lands, but the scheduler endpoint, advisory-lock discipline, status
 * machine, and migration are all exercised in production.
 */
async function ingestPage(
  _client: pg.PoolClient,
  _customerId: number,
  _afterCursor: string | null,
): Promise<{
  observedInserted: number;
  baselineInserted: number;
  endCursor: string | null;
  hasNextPage: boolean;
}> {
  // TODO(review-web#842): replace this stub with a real pager.
  //
  //   1. Build EventStandardFilterInput (no triagePolicies field).
  //   2. graphqlRequest(EVENT_LIST_WITH_TRIAGE_QUERY, { filter, first,
  //      after, triage: null }, { role, customerIds: [customerId] }).
  //   3. For each node:
  //        - Extract event_key (NUMERIC(39,0)) from the GraphQL field.
  //        - Normalize host / dns_query / uri per event-kind mapping.
  //        - Drop if any active exclusion (CIDR / hostname / domain
  //          regex / uri exact) matches.
  //   4. INSERT survivors into observed_event_meta (ON CONFLICT DO
  //      NOTHING).
  //   5. INSERT baseline-passing subset (Phase 1.A category whitelist
  //      OR HttpThreat with cluster_id IS NULL) into
  //      baseline_triaged_event (ON CONFLICT DO NOTHING) with
  //      baseline_version = PHASE_1A_BASELINE_VERSION,
  //      baseline_score  = PHASE_1A_BASELINE_SCORE,
  //      selector_tags   = ARRAY[PHASE_1A_SELECTOR_TAG],
  //      exclusions_fp   = computeExclusionsFingerprint(active).
  //   6. Return endCursor + hasNextPage so the outer driver can either
  //      advance the watermark or break out of the loop on the last
  //      page.
  return {
    observedInserted: 0,
    baselineInserted: 0,
    endCursor: null,
    hasNextPage: false,
  };
}

/**
 * Page-bounded driver. Walks pages until either the resolver reports
 * no more pages or `MAX_PAGES_PER_RUN` is reached, accumulating row
 * counts and the latest end cursor. Hard cap defends against a runaway
 * loop if the resolver ever reports `hasNextPage = true` on every page.
 */
const MAX_PAGES_PER_RUN = 200;

async function drivePages(
  client: pg.PoolClient,
  customerId: number,
  startCursor: string | null,
): Promise<{
  observedInserted: number;
  baselineInserted: number;
  endCursor: string | null;
}> {
  let cursor = startCursor;
  let observedInserted = 0;
  let baselineInserted = 0;
  for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
    const out = await ingestPage(client, customerId, cursor);
    observedInserted += out.observedInserted;
    baselineInserted += out.baselineInserted;
    if (out.endCursor !== null) cursor = out.endCursor;
    if (!out.hasNextPage) break;
  }
  return {
    observedInserted,
    baselineInserted,
    endCursor: cursor,
  };
}

/**
 * Run one cadence pass for a single customer. Resolves the customer's
 * tenant pool, opens a single transaction, takes the per-customer
 * advisory lock, and either drives pages to completion + commits or
 * exits without touching state.
 */
export async function runTriageBaselineCadence(
  customerId: number,
): Promise<CadenceRunResult> {
  // Lets `CustomerNotFoundError` propagate so the route handler can
  // surface it as a 404. In-process callers (future batched drivers,
  // tests) catch the same error type if they want a "skip" instead.
  const pool = await getCustomerPool(customerId);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const lockResult = await client.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_xact_lock(${buildLockKeyExpr()}) AS acquired`,
        [buildLockKeyParam(customerId)],
      );
      const acquired = lockResult.rows[0]?.acquired === true;
      if (!acquired) {
        // Concurrent run holds the lock. Roll back so we leave the row
        // alone — the active runner will write the watermark.
        await client.query("ROLLBACK");
        return {
          customerId,
          status: "skipped",
          observedInserted: 0,
          baselineInserted: 0,
          lastEventCursor: null,
        };
      }

      const state = await readOrInitCorpusState(client);
      await markRunning(client);

      const driven = await drivePages(
        client,
        customerId,
        state.last_event_cursor,
      );

      await markOk(client, driven.endCursor, EMPTY_EXCLUSIONS_FP);
      await client.query("COMMIT");
      return {
        customerId,
        status: "ok",
        observedInserted: driven.observedInserted,
        baselineInserted: driven.baselineInserted,
        lastEventCursor: driven.endCursor,
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {
        // Already rolled back or connection broken; nothing to do.
      });
      const message = err instanceof Error ? err.message : "Cadence failed";
      await markFailed(pool, message);
      return {
        customerId,
        status: "failed",
        observedInserted: 0,
        baselineInserted: 0,
        lastEventCursor: null,
        error: message,
      };
    }
  } finally {
    client.release();
  }
}

/**
 * Internal-token guard for the cadence route handler. Reads the
 * shared secret from `TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN`. Mirrors
 * the apply-attempt cleanup token check: constant-time comparison via
 * `timingSafeEqual` after a length precheck so unequal-length probes
 * do not leak through the early-return.
 */
export function verifyTriageBaselineCadenceToken(
  provided: string | null,
): boolean {
  const expected = process.env.TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN;
  if (!expected) return false;
  if (!provided) return false;
  if (provided.length !== expected.length) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const _testing = {
  buildLockKeyParam,
  EMPTY_EXCLUSIONS_FP,
};
