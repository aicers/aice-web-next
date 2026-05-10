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
 * ingest. Every per-page transaction starts by taking a per-customer
 * transaction-scoped advisory lock:
 *
 *   `pg_try_advisory_xact_lock(hashtext('triage_baseline_cadence:' || customer_id))`
 *
 * If the lock is unavailable on the first page, the runner exits cleanly
 * without touching `baseline_corpus_state` — the next scheduled tick
 * picks up where the previous run stopped via `last_event_cursor`. Lock
 * release is automatic on commit/rollback because it is transaction-
 * scoped. A run holds the lock only across one page transaction at a
 * time, so multiple cadence pages do not stretch a long-lived database
 * transaction.
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
 * Steps (a)–(f) for a single page commit as one DB transaction. PK
 * collisions on re-ingest of the same `event_key` are handled with
 * `ON CONFLICT DO NOTHING`.
 *
 * ## Pager wiring
 *
 * The actual GraphQL pager — steps (a)–(e) — is injected via the
 * {@link CadencePager} interface so the runner stays focused on the
 * lock / transaction / status-machine plumbing. Production callers
 * (the route handler) pass the result of `createCadencePager()` from
 * `./pager.ts`; tests inject a fake.
 */

import { timingSafeEqual } from "node:crypto";

import type pg from "pg";

import { EMPTY_EXCLUSIONS_FINGERPRINT } from "@/lib/triage/exclusion";
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
 * Phase 1.A additive score components. Replaces the original flat
 * `PHASE_1A_BASELINE_SCORE` placeholder shipped in PR #478. The scoring
 * helper in `src/lib/triage/scoring.ts` exports the same numeric
 * literals so the menu-side and cadence-side scoring agree on the
 * value of each component.
 */
export {
  PHASE_1A_CLUSTER_NONE_BONUS,
  PHASE_1A_WHITELIST_SCORE,
} from "@/lib/triage/scoring";

export type CadenceRunStatus = "ok" | "failed" | "running" | "skipped";

export interface CadenceRunResult {
  /** Customer the runner targeted. */
  customerId: number;
  /**
   * Outcome marker:
   *   - `ok`: at least one page committed cleanly.
   *   - `skipped`: the per-customer advisory lock was unavailable on
   *     the very first page; this tick is a no-op.
   *   - `failed`: a page rolled back; `error` carries the message that
   *     was persisted to `baseline_corpus_state.last_error`.
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

export interface CadencePageResult {
  /** Rows inserted into `observed_event_meta` for this page. */
  observedInserted: number;
  /** Rows inserted into `baseline_triaged_event` for this page. */
  baselineInserted: number;
  /**
   * End cursor of the page as reported by the resolver, or `null` if
   * the resolver returned no edges. Used to advance
   * `baseline_corpus_state.last_event_cursor`.
   */
  endCursor: string | null;
  /** Whether the resolver indicates more pages are available. */
  hasNextPage: boolean;
}

/**
 * Fetch + insert one page of standard-filter survivors. The runner
 * threads `afterCursor` from the previous page's `endCursor` (or
 * `baseline_corpus_state.last_event_cursor` on the first page) and
 * runs every call inside an open page transaction with the per-customer
 * advisory lock already held.
 */
export interface CadencePager {
  ingestPage(
    client: pg.PoolClient,
    customerId: number,
    afterCursor: string | null,
  ): Promise<CadencePageResult>;
}

const LOCK_NAMESPACE = "triage_baseline_cadence:";

/**
 * Letting the database compute the hash avoids a Node ↔ Postgres
 * consistency trap (Postgres' `hashtext` is not equivalent to any
 * well-known JS hash).
 */
function buildLockKeyExpr(): string {
  return `hashtext($1)`;
}

function buildLockKeyParam(customerId: number): string {
  return `${LOCK_NAMESPACE}${customerId}`;
}

/**
 * Empty-set exclusion fingerprint, computed once via the shared helper
 * in `src/lib/triage/exclusion`. Pre-#457 the cadence runs against an
 * empty active exclusion set; every row therefore carries this real
 * (NOT NULL) fingerprint until the storage adapter lands and starts
 * returning real rules.
 */
const EMPTY_EXCLUSIONS_FP = EMPTY_EXCLUSIONS_FINGERPRINT;

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
 * Hard cap on pages per cadence run. Defends against a runaway loop if
 * the resolver ever reports `hasNextPage = true` indefinitely. With
 * per-page transactions, the cap also bounds how long a single cadence
 * tick can hold the connection.
 */
const MAX_PAGES_PER_RUN = 200;

/**
 * Run one cadence pass for a single customer. Walks pages until either
 * the resolver reports `hasNextPage = false` or `MAX_PAGES_PER_RUN` is
 * reached, committing each page's INSERTs + watermark UPDATE in its own
 * transaction so progress is preserved if a later page fails.
 */
export async function runTriageBaselineCadence(
  customerId: number,
  options: { pager: CadencePager },
): Promise<CadenceRunResult> {
  const { pager } = options;

  // Lets `CustomerNotFoundError` propagate so the route handler can
  // surface it as a 404. In-process callers (future batched drivers,
  // tests) catch the same error type if they want a "skip" instead.
  const pool = await getCustomerPool(customerId);

  const client = await pool.connect();
  let totalObserved = 0;
  let totalBaseline = 0;
  let lastCommittedCursor: string | null = null;
  let nextStartCursor: string | null = null;
  let isFirstPage = true;

  try {
    for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
      let pageCommitted = false;
      try {
        await client.query("BEGIN");

        const lockResult = await client.query<{ acquired: boolean }>(
          `SELECT pg_try_advisory_xact_lock(${buildLockKeyExpr()}) AS acquired`,
          [buildLockKeyParam(customerId)],
        );
        const acquired = lockResult.rows[0]?.acquired === true;
        if (!acquired) {
          await client.query("ROLLBACK");
          if (isFirstPage) {
            return {
              customerId,
              status: "skipped",
              observedInserted: 0,
              baselineInserted: 0,
              lastEventCursor: null,
            };
          }
          // Mid-run lock loss (rare: a competing scheduler tick grabbed
          // the lock between two of our page commits). Stop cleanly at
          // the watermark we already committed; the competing run will
          // continue from there.
          break;
        }

        if (isFirstPage) {
          const state = await readOrInitCorpusState(client);
          await markRunning(client);
          nextStartCursor = state.last_event_cursor;
        }

        const ingest = await pager.ingestPage(
          client,
          customerId,
          nextStartCursor,
        );

        await markOk(client, ingest.endCursor, EMPTY_EXCLUSIONS_FP);
        await client.query("COMMIT");
        pageCommitted = true;

        totalObserved += ingest.observedInserted;
        totalBaseline += ingest.baselineInserted;
        if (ingest.endCursor !== null) {
          nextStartCursor = ingest.endCursor;
          lastCommittedCursor = ingest.endCursor;
        }
        isFirstPage = false;
        if (!ingest.hasNextPage) break;
      } catch (err) {
        if (!pageCommitted) {
          await client.query("ROLLBACK").catch(() => {
            // Already rolled back or connection broken; nothing to do.
          });
        }
        const message = err instanceof Error ? err.message : "Cadence failed";
        await markFailed(pool, message);
        return {
          customerId,
          status: "failed",
          observedInserted: totalObserved,
          baselineInserted: totalBaseline,
          lastEventCursor: lastCommittedCursor,
          error: message,
        };
      }
    }

    return {
      customerId,
      status: "ok",
      observedInserted: totalObserved,
      baselineInserted: totalBaseline,
      lastEventCursor: lastCommittedCursor,
    };
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
