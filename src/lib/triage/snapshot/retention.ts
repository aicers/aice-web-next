import "server-only";

/**
 * Triage condition-snapshot retention (#472).
 *
 * Snapshots live as long as any corpus row references their
 * fingerprint, plus a 30-day grace period past the latest referencing
 * row's expiration. This is a new sweep — not an extension of the
 * existing per-corpus retention jobs (`baseline/retention.ts`,
 * `policy/corpus-b/retention.ts`) — because snapshot rows are
 * referenced from BOTH corpora simultaneously:
 *
 *   - `exclusion_snapshot.fingerprint` is referenced by
 *     `baseline_triaged_event.exclusions_fp` AND
 *     `policy_triage_run.exclusions_fingerprint`.
 *   - `policy_snapshot.fingerprint` is referenced by
 *     `policy_triage_run.policies_fingerprint`.
 *   - `baseline_version_snapshot.version` is referenced by
 *     `baseline_triaged_event.baseline_version` AND
 *     `policy_triage_run.baseline_version`.
 *
 * A snapshot row must survive until both reference sets are empty.
 * Folding this into either corpus's existing retention job would
 * couple it to the other corpus's lifecycle in ways the existing
 * code does not handle.
 *
 * Policy details:
 *
 *   - `exclusion_snapshot` / `policy_snapshot`: delete rows whose
 *     `captured_at` is older than `(corpus retention window + grace)`
 *     AND whose fingerprint is not referenced by any current corpus
 *     row. The corpus A baseline window is 180 days; the corpus B
 *     ready window is 30 days; the grace period adds 30 days on top
 *     of the longer window. The reference probe is the load-bearing
 *     check — the time gate is just an optimization that skips the
 *     probe for snapshots too recent to possibly be unreferenced.
 *   - `baseline_version_snapshot`: retained forever (small, valuable,
 *     no realistic growth concern). The sweep simply skips this
 *     table. A future tombstone column can flip this if a version
 *     ever needs to be purged.
 *
 * Each tenant DB sweeps independently; orchestration mirrors the
 * existing per-corpus dispatch jobs.
 */

import type pg from "pg";

import { query as authDbQuery } from "@/lib/db/client";
import { getCustomerPool } from "@/lib/triage/policy/customer-db";

export const DEFAULT_DELETE_BATCH_SIZE = 10_000;

/**
 * Snapshots are guaranteed unreferenced only after the longest
 * corpus retention window has elapsed. We compute the grace cutoff
 * relative to `captured_at` rather than the latest referencing row's
 * time because the snapshot writer stamps `captured_at` once at the
 * first observation; using it for the time gate keeps the predicate
 * a simple range filter while the reference probe handles the
 * correctness guarantee.
 */
export const SNAPSHOT_GRACE_DAYS = 30;
export const EXCLUSION_SNAPSHOT_MAX_REFERENCE_WINDOW_DAYS = 180; // matches baseline corpus A retention
export const POLICY_SNAPSHOT_MAX_REFERENCE_WINDOW_DAYS = 30; // matches corpus B ready retention

export interface SnapshotRetentionCounts {
  exclusionSnapshotsPruned: number;
  policySnapshotsPruned: number;
}

export interface SnapshotRetentionCustomerResult {
  customerId: number;
  status: "ok" | "failed";
  counts: SnapshotRetentionCounts;
  error?: string;
}

export interface SnapshotRetentionResult {
  overall: "ok" | "partial" | "failed";
  perCustomer: SnapshotRetentionCustomerResult[];
}

function emptyCounts(): SnapshotRetentionCounts {
  return {
    exclusionSnapshotsPruned: 0,
    policySnapshotsPruned: 0,
  };
}

/**
 * Delete `exclusion_snapshot` rows older than the configured grace
 * cutoff whose fingerprint is referenced by neither corpus's table.
 * The double NOT EXISTS guarantees we never prune a snapshot a live
 * corpus row would join against — the corpus's own retention sweep
 * is the upstream gate that releases references.
 */
async function pruneExclusionSnapshots(
  pool: pg.Pool,
  graceCutoffDays: number,
  batchSize: number,
): Promise<number> {
  let total = 0;
  while (true) {
    const result = await pool.query(
      `DELETE FROM exclusion_snapshot
        WHERE fingerprint IN (
          SELECT s.fingerprint
            FROM exclusion_snapshot s
           WHERE s.captured_at < NOW() - ($1 || ' days')::INTERVAL
             AND NOT EXISTS (
                 SELECT 1 FROM baseline_triaged_event b
                  WHERE b.exclusions_fp = s.fingerprint
             )
             AND NOT EXISTS (
                 SELECT 1 FROM policy_triage_run r
                  WHERE r.exclusions_fingerprint = s.fingerprint
             )
           LIMIT ${batchSize}
        )`,
      [String(graceCutoffDays)],
    );
    const n = result.rowCount ?? 0;
    total += n;
    if (n < batchSize) break;
  }
  return total;
}

/**
 * Delete `policy_snapshot` rows older than the configured grace cutoff
 * whose fingerprint is referenced by no `policy_triage_run` row. The
 * corpus A table never references `policy_snapshot`, so the probe is
 * single-sided.
 */
async function prunePolicySnapshots(
  pool: pg.Pool,
  graceCutoffDays: number,
  batchSize: number,
): Promise<number> {
  let total = 0;
  while (true) {
    const result = await pool.query(
      `DELETE FROM policy_snapshot
        WHERE fingerprint IN (
          SELECT s.fingerprint
            FROM policy_snapshot s
           WHERE s.captured_at < NOW() - ($1 || ' days')::INTERVAL
             AND NOT EXISTS (
                 SELECT 1 FROM policy_triage_run r
                  WHERE r.policies_fingerprint = s.fingerprint
             )
           LIMIT ${batchSize}
        )`,
      [String(graceCutoffDays)],
    );
    const n = result.rowCount ?? 0;
    total += n;
    if (n < batchSize) break;
  }
  return total;
}

export async function runSnapshotRetentionForCustomer(
  customerId: number,
  options: { batchSize?: number } = {},
): Promise<SnapshotRetentionCounts> {
  const batchSize = options.batchSize ?? DEFAULT_DELETE_BATCH_SIZE;
  const pool = await getCustomerPool(customerId);
  const counts = emptyCounts();

  // The exclusion grace cutoff is the corpus A retention window
  // (180d) + grace; the corpus B `ready` window (30d) is strictly
  // shorter so the same cutoff covers references from both corpora.
  // Snapshots referenced from a still-living `baseline_triaged_event`
  // row would survive the time gate trivially because that row's own
  // event_time is < cutoff days old, but the NOT EXISTS probe is the
  // load-bearing guard either way.
  counts.exclusionSnapshotsPruned = await pruneExclusionSnapshots(
    pool,
    EXCLUSION_SNAPSHOT_MAX_REFERENCE_WINDOW_DAYS + SNAPSHOT_GRACE_DAYS,
    batchSize,
  );
  counts.policySnapshotsPruned = await prunePolicySnapshots(
    pool,
    POLICY_SNAPSHOT_MAX_REFERENCE_WINDOW_DAYS + SNAPSHOT_GRACE_DAYS,
    batchSize,
  );
  // `baseline_version_snapshot` is intentionally retained forever.

  return counts;
}

async function defaultListActiveCustomers(): Promise<number[]> {
  const result = await authDbQuery<{ id: number }>(
    "SELECT id FROM customers WHERE status = 'active' ORDER BY id",
  );
  return result.rows.map((r) => Number(r.id));
}

export interface SnapshotRetentionOptions {
  batchSize?: number;
  listActiveCustomers?: () => Promise<number[]>;
  runForCustomer?: (
    customerId: number,
    options: { batchSize?: number },
  ) => Promise<SnapshotRetentionCounts>;
}

export async function runSnapshotRetentionDispatch(
  options: SnapshotRetentionOptions = {},
): Promise<SnapshotRetentionResult> {
  const batchSize = options.batchSize ?? DEFAULT_DELETE_BATCH_SIZE;
  const listActiveCustomers =
    options.listActiveCustomers ?? defaultListActiveCustomers;
  const runForCustomer =
    options.runForCustomer ?? runSnapshotRetentionForCustomer;

  const customerIds = await listActiveCustomers();
  const perCustomer: SnapshotRetentionCustomerResult[] = [];
  for (const customerId of customerIds) {
    try {
      const counts = await runForCustomer(customerId, { batchSize });
      perCustomer.push({ customerId, status: "ok", counts });
    } catch (err) {
      perCustomer.push({
        customerId,
        status: "failed",
        counts: emptyCounts(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const overall: SnapshotRetentionResult["overall"] = perCustomer.some(
    (e) => e.status === "failed",
  )
    ? "partial"
    : "ok";
  return { overall, perCustomer };
}

/**
 * Internal-token guard for the snapshot retention route. Reads
 * `TRIAGE_SNAPSHOT_RETENTION_INTERNAL_TOKEN`. Constant-time compare,
 * mirrors the baseline / policy retention guards.
 */
export function verifyTriageSnapshotRetentionToken(
  provided: string | null,
): boolean {
  const expected = process.env.TRIAGE_SNAPSHOT_RETENTION_INTERNAL_TOKEN;
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
