import "server-only";

import type pg from "pg";

import { getCustomerPool } from "@/lib/triage/policy/customer-db";

/**
 * Triage baseline corpus retention (#461 / 1B-7).
 *
 * Two cleanup sweeps, one per corpus A table:
 *   - `baseline_triaged_event`  — 180 days from `event_time`.
 *   - `observed_event_meta`     — 30 days from `event_time` (kept short
 *     because it only serves window-aggregate stats, not menu display).
 *
 * Both deletes run in batches of `DEFAULT_DELETE_BATCH_SIZE` rows per
 * statement against the per-customer tenant DB to bound lock duration
 * and WAL pressure. Each batch is its own transaction; a crashed runner
 * leaves the partial cleanup in place and the next sweep finishes it.
 *
 * The retention windows are intentionally separate from the
 * retroactive-DELETE planner (which deletes by *match*, not by *age*)
 * even though both target the same tables. Sharing batch sizes keeps
 * lock-time intuition aligned across the two surfaces.
 */

export const DEFAULT_DELETE_BATCH_SIZE = 10_000;

export const BASELINE_TRIAGED_EVENT_RETENTION_DAYS = 180;
export const OBSERVED_EVENT_META_RETENTION_DAYS = 30;

export interface BaselineRetentionCounts {
  baselineTriagedEvent: number;
  observedEventMeta: number;
}

export interface BaselineRetentionCustomerResult {
  customerId: number;
  status: "ok" | "failed";
  counts: BaselineRetentionCounts;
  error?: string;
}

export interface BaselineRetentionResult {
  overall: "ok" | "partial" | "failed";
  perCustomer: BaselineRetentionCustomerResult[];
}

interface RetentionTable {
  table: string;
  retentionDays: number;
  key: keyof BaselineRetentionCounts;
}

const TABLES: readonly RetentionTable[] = [
  {
    table: "baseline_triaged_event",
    retentionDays: BASELINE_TRIAGED_EVENT_RETENTION_DAYS,
    key: "baselineTriagedEvent",
  },
  {
    table: "observed_event_meta",
    retentionDays: OBSERVED_EVENT_META_RETENTION_DAYS,
    key: "observedEventMeta",
  },
];

async function sweepCustomerTable(
  pool: pg.Pool,
  entry: RetentionTable,
  batchSize: number,
): Promise<number> {
  let total = 0;
  while (true) {
    // One DELETE per loop iteration, each in its own transaction (no
    // explicit BEGIN — single-statement transactions are auto-commit).
    // `ctid IN (SELECT ... LIMIT n)` keeps the row-set bounded and the
    // lock duration short.
    const result = await pool.query(
      `DELETE FROM ${entry.table}
        WHERE ctid IN (
          SELECT ctid FROM ${entry.table}
           WHERE event_time < NOW() - ($1 || ' days')::INTERVAL
           LIMIT ${batchSize}
        )`,
      [String(entry.retentionDays)],
    );
    const n = result.rowCount ?? 0;
    total += n;
    if (n < batchSize) break;
  }
  return total;
}

/**
 * Run the corpus A retention sweeps for one customer. Errors propagate
 * to the caller so the fan-out path can record `status: 'failed'`
 * without aborting the rest of the customers.
 */
export async function runBaselineRetentionForCustomer(
  customerId: number,
  options: { batchSize?: number } = {},
): Promise<BaselineRetentionCounts> {
  const batchSize = options.batchSize ?? DEFAULT_DELETE_BATCH_SIZE;
  const pool = await getCustomerPool(customerId);
  const counts: BaselineRetentionCounts = {
    baselineTriagedEvent: 0,
    observedEventMeta: 0,
  };
  for (const entry of TABLES) {
    counts[entry.key] = await sweepCustomerTable(pool, entry, batchSize);
  }
  return counts;
}

/**
 * Default active-customer enumerator. Lazily imports `pg` so tests that
 * stub the enumerator do not load the real client.
 */
async function defaultListActiveCustomers(): Promise<number[]> {
  const { query } = await import("@/lib/db/client");
  const result = await query<{ id: number }>(
    "SELECT id FROM customers WHERE status = 'active' ORDER BY id",
  );
  return result.rows.map((r) => Number(r.id));
}

export interface BaselineRetentionOptions {
  batchSize?: number;
  listActiveCustomers?: () => Promise<number[]>;
  runForCustomer?: (
    customerId: number,
    options: { batchSize?: number },
  ) => Promise<BaselineRetentionCounts>;
}

/**
 * Dispatch the corpus A retention sweep across every active customer.
 * Returns a structured `perCustomer[]` so the cron wrapper can summarise
 * per-tenant outcomes. A self-failure in the enumerator throws; a
 * per-customer failure is captured in the response.
 */
export async function runBaselineRetentionDispatch(
  options: BaselineRetentionOptions = {},
): Promise<BaselineRetentionResult> {
  const batchSize = options.batchSize ?? DEFAULT_DELETE_BATCH_SIZE;
  const listActiveCustomers =
    options.listActiveCustomers ?? defaultListActiveCustomers;
  const runForCustomer =
    options.runForCustomer ?? runBaselineRetentionForCustomer;

  const customerIds = await listActiveCustomers();
  const perCustomer: BaselineRetentionCustomerResult[] = [];
  for (const customerId of customerIds) {
    try {
      const counts = await runForCustomer(customerId, { batchSize });
      perCustomer.push({ customerId, status: "ok", counts });
    } catch (err) {
      perCustomer.push({
        customerId,
        status: "failed",
        counts: { baselineTriagedEvent: 0, observedEventMeta: 0 },
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const overall: BaselineRetentionResult["overall"] = perCustomer.some(
    (e) => e.status === "failed",
  )
    ? "partial"
    : "ok";
  return { overall, perCustomer };
}

/**
 * Internal-token guard for the retention route. Reads
 * `TRIAGE_BASELINE_RETENTION_INTERNAL_TOKEN`. Constant-time compare.
 */
export function verifyTriageBaselineRetentionToken(
  provided: string | null,
): boolean {
  const expected = process.env.TRIAGE_BASELINE_RETENTION_INTERNAL_TOKEN;
  if (!expected) return false;
  if (!provided) return false;
  if (provided.length !== expected.length) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}
