import "server-only";

import type pg from "pg";

import { getCustomerPool } from "@/lib/triage/policy/customer-db";
import {
  ENGAGEMENT_ACTION_RETENTION_DAYS,
  ENGAGEMENT_IMPRESSION_RETENTION_DAYS,
} from "./types";

/**
 * Triage engagement-signal retention (#588).
 *
 * Two cleanup sweeps, one per engagement table:
 *   - `engagement_impression` — 90 days from `created_at`.
 *   - `engagement_action`     — 180 days from `created_at`.
 *
 * Both deletes run in batches of `DEFAULT_DELETE_BATCH_SIZE` rows
 * per statement against the per-customer tenant DB to bound lock
 * duration and WAL pressure. Each batch is its own auto-commit
 * transaction; a crashed runner leaves the partial cleanup in
 * place and the next sweep finishes it.
 *
 * Both tables are append-only and the retention edge is
 * `created_at`, indexed by `engagement_impression_created_at_idx`
 * and `engagement_action_created_at_idx`. Floors
 * mirror {@link ENGAGEMENT_IMPRESSION_RETENTION_DAYS} and
 * {@link ENGAGEMENT_ACTION_RETENTION_DAYS} from
 * `src/lib/triage/engagement/types.ts` so the source of truth
 * lives in one place.
 */

export const DEFAULT_DELETE_BATCH_SIZE = 10_000;

export interface EngagementRetentionCounts {
  engagementImpression: number;
  engagementAction: number;
}

export interface EngagementRetentionCustomerResult {
  customerId: number;
  status: "ok" | "failed";
  counts: EngagementRetentionCounts;
  error?: string;
}

export interface EngagementRetentionResult {
  overall: "ok" | "partial" | "failed";
  perCustomer: EngagementRetentionCustomerResult[];
}

interface RetentionTable {
  table: string;
  retentionDays: number;
  key: keyof EngagementRetentionCounts;
}

const TABLES: readonly RetentionTable[] = [
  {
    table: "engagement_impression",
    retentionDays: ENGAGEMENT_IMPRESSION_RETENTION_DAYS,
    key: "engagementImpression",
  },
  {
    table: "engagement_action",
    retentionDays: ENGAGEMENT_ACTION_RETENTION_DAYS,
    key: "engagementAction",
  },
];

async function sweepCustomerTable(
  pool: pg.Pool,
  entry: RetentionTable,
  batchSize: number,
): Promise<number> {
  let total = 0;
  while (true) {
    const result = await pool.query(
      `DELETE FROM ${entry.table}
        WHERE ctid IN (
          SELECT ctid FROM ${entry.table}
           WHERE created_at < NOW() - ($1 || ' days')::INTERVAL
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
 * Run the engagement retention sweeps for one customer. Errors
 * propagate to the caller so the fan-out path can record
 * `status: 'failed'` without aborting the rest of the customers.
 */
export async function runEngagementRetentionForCustomer(
  customerId: number,
  options: { batchSize?: number } = {},
): Promise<EngagementRetentionCounts> {
  const batchSize = options.batchSize ?? DEFAULT_DELETE_BATCH_SIZE;
  const pool = await getCustomerPool(customerId);
  const counts: EngagementRetentionCounts = {
    engagementImpression: 0,
    engagementAction: 0,
  };
  for (const entry of TABLES) {
    counts[entry.key] = await sweepCustomerTable(pool, entry, batchSize);
  }
  return counts;
}

async function defaultListActiveCustomers(): Promise<number[]> {
  const { query } = await import("@/lib/db/client");
  const result = await query<{ id: number }>(
    "SELECT id FROM customers WHERE status = 'active' ORDER BY id",
  );
  return result.rows.map((r) => Number(r.id));
}

export interface EngagementRetentionOptions {
  batchSize?: number;
  listActiveCustomers?: () => Promise<number[]>;
  runForCustomer?: (
    customerId: number,
    options: { batchSize?: number },
  ) => Promise<EngagementRetentionCounts>;
}

/**
 * Dispatch the engagement retention sweep across every active
 * customer. Returns a structured `perCustomer[]` so the cron
 * wrapper can summarise per-tenant outcomes. A self-failure in
 * the enumerator throws; a per-customer failure is captured in
 * the response.
 */
export async function runEngagementRetentionDispatch(
  options: EngagementRetentionOptions = {},
): Promise<EngagementRetentionResult> {
  const batchSize = options.batchSize ?? DEFAULT_DELETE_BATCH_SIZE;
  const listActiveCustomers =
    options.listActiveCustomers ?? defaultListActiveCustomers;
  const runForCustomer =
    options.runForCustomer ?? runEngagementRetentionForCustomer;

  const customerIds = await listActiveCustomers();
  const perCustomer: EngagementRetentionCustomerResult[] = [];
  for (const customerId of customerIds) {
    try {
      const counts = await runForCustomer(customerId, { batchSize });
      perCustomer.push({ customerId, status: "ok", counts });
    } catch (err) {
      perCustomer.push({
        customerId,
        status: "failed",
        counts: { engagementImpression: 0, engagementAction: 0 },
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const overall: EngagementRetentionResult["overall"] = perCustomer.some(
    (e) => e.status === "failed",
  )
    ? "partial"
    : "ok";
  return { overall, perCustomer };
}

/**
 * Internal-token guard for the engagement retention route. Reads
 * `TRIAGE_ENGAGEMENT_RETENTION_INTERNAL_TOKEN`. Constant-time
 * compare, mirrors the baseline / snapshot retention guards so a
 * leaked secret cannot pivot across surfaces.
 */
export function verifyTriageEngagementRetentionToken(
  provided: string | null,
): boolean {
  const expected = process.env.TRIAGE_ENGAGEMENT_RETENTION_INTERNAL_TOKEN;
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
