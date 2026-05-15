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
 * Two-phase mark/delete (per #472 review feedback):
 *
 *   `captured_at` is fixed at first observation. Basing the grace
 *   cutoff on `captured_at` would prune a long-lived fingerprint as
 *   soon as its last reference aged out, with no post-expiration
 *   grace at all (example: fingerprint captured on day 0, last
 *   corpus row written day 170 and aged out day 350 — `captured_at`
 *   is already 350 days old, well past any captured-at-based
 *   cutoff). To honor the issue's "30 days past the latest
 *   referencing row's expiration" rule we use a tombstone column
 *   `unreferenced_since` and a two-phase sweep per table:
 *
 *     Phase 1 (mark)   — UPDATE: stamp `unreferenced_since = NOW()`
 *                        on rows whose reference probe returned zero
 *                        and that aren't already tombstoned.
 *     Phase 2 (revive) — UPDATE: clear `unreferenced_since` on
 *                        rows whose reference probe now returns
 *                        non-zero. A revival is possible because
 *                        identical condition sets re-mint the same
 *                        fingerprint, so a stable exclusion set
 *                        whose last reference aged out can later
 *                        regain references when cadence resumes.
 *     Phase 3 (delete) — DELETE rows where `unreferenced_since` is
 *                        older than the 30-day grace AND the
 *                        reference probe still returns zero.
 *
 *   `baseline_version_snapshot` is retained forever (small,
 *   valuable, no realistic growth concern). The sweep simply skips
 *   this table. A future tombstone column can flip this if a version
 *   ever needs to be purged.
 *
 * Each tenant DB sweeps independently; orchestration mirrors the
 * existing per-corpus dispatch jobs.
 */

import type pg from "pg";

import { query as authDbQuery } from "@/lib/db/client";
import { getCustomerPool } from "@/lib/triage/policy/customer-db";

export const DEFAULT_DELETE_BATCH_SIZE = 10_000;

/**
 * Grace period applied *after* the snapshot's last reference is
 * observed to have disappeared (tracked via `unreferenced_since`),
 * NOT after `captured_at`. See the file header for rationale.
 */
export const SNAPSHOT_GRACE_DAYS = 30;

export interface SnapshotRetentionCounts {
  exclusionSnapshotsTombstoned: number;
  exclusionSnapshotsRevived: number;
  exclusionSnapshotsPruned: number;
  policySnapshotsTombstoned: number;
  policySnapshotsRevived: number;
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
    exclusionSnapshotsTombstoned: 0,
    exclusionSnapshotsRevived: 0,
    exclusionSnapshotsPruned: 0,
    policySnapshotsTombstoned: 0,
    policySnapshotsRevived: 0,
    policySnapshotsPruned: 0,
  };
}

interface SweepCounts {
  tombstoned: number;
  revived: number;
  pruned: number;
}

/**
 * Two-phase mark/revive/delete sweep on `exclusion_snapshot`. The
 * reference probe joins against both corpus tables because either may
 * reference `exclusions_fp` / `exclusions_fingerprint`.
 */
async function sweepExclusionSnapshots(
  pool: pg.Pool,
  graceDays: number,
  batchSize: number,
): Promise<SweepCounts> {
  const counts: SweepCounts = { tombstoned: 0, revived: 0, pruned: 0 };

  const markResult = await pool.query(
    `UPDATE exclusion_snapshot
        SET unreferenced_since = NOW()
      WHERE unreferenced_since IS NULL
        AND NOT EXISTS (
            SELECT 1 FROM baseline_triaged_event b
             WHERE b.exclusions_fp = exclusion_snapshot.fingerprint
        )
        AND NOT EXISTS (
            SELECT 1 FROM policy_triage_run r
             WHERE r.exclusions_fingerprint = exclusion_snapshot.fingerprint
        )`,
  );
  counts.tombstoned = markResult.rowCount ?? 0;

  const reviveResult = await pool.query(
    `UPDATE exclusion_snapshot
        SET unreferenced_since = NULL
      WHERE unreferenced_since IS NOT NULL
        AND (
            EXISTS (
                SELECT 1 FROM baseline_triaged_event b
                 WHERE b.exclusions_fp = exclusion_snapshot.fingerprint
            )
            OR EXISTS (
                SELECT 1 FROM policy_triage_run r
                 WHERE r.exclusions_fingerprint = exclusion_snapshot.fingerprint
            )
        )`,
  );
  counts.revived = reviveResult.rowCount ?? 0;

  while (true) {
    const deleteResult = await pool.query(
      `DELETE FROM exclusion_snapshot
        WHERE fingerprint IN (
          SELECT s.fingerprint
            FROM exclusion_snapshot s
           WHERE s.unreferenced_since IS NOT NULL
             AND s.unreferenced_since < NOW() - ($1 || ' days')::INTERVAL
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
      [String(graceDays)],
    );
    const n = deleteResult.rowCount ?? 0;
    counts.pruned += n;
    if (n < batchSize) break;
  }
  return counts;
}

/**
 * Two-phase mark/revive/delete sweep on `policy_snapshot`. The
 * reference probe is single-sided — only `policy_triage_run`
 * references `policies_fingerprint`.
 */
async function sweepPolicySnapshots(
  pool: pg.Pool,
  graceDays: number,
  batchSize: number,
): Promise<SweepCounts> {
  const counts: SweepCounts = { tombstoned: 0, revived: 0, pruned: 0 };

  const markResult = await pool.query(
    `UPDATE policy_snapshot
        SET unreferenced_since = NOW()
      WHERE unreferenced_since IS NULL
        AND NOT EXISTS (
            SELECT 1 FROM policy_triage_run r
             WHERE r.policies_fingerprint = policy_snapshot.fingerprint
        )`,
  );
  counts.tombstoned = markResult.rowCount ?? 0;

  const reviveResult = await pool.query(
    `UPDATE policy_snapshot
        SET unreferenced_since = NULL
      WHERE unreferenced_since IS NOT NULL
        AND EXISTS (
            SELECT 1 FROM policy_triage_run r
             WHERE r.policies_fingerprint = policy_snapshot.fingerprint
        )`,
  );
  counts.revived = reviveResult.rowCount ?? 0;

  while (true) {
    const deleteResult = await pool.query(
      `DELETE FROM policy_snapshot
        WHERE fingerprint IN (
          SELECT s.fingerprint
            FROM policy_snapshot s
           WHERE s.unreferenced_since IS NOT NULL
             AND s.unreferenced_since < NOW() - ($1 || ' days')::INTERVAL
             AND NOT EXISTS (
                 SELECT 1 FROM policy_triage_run r
                  WHERE r.policies_fingerprint = s.fingerprint
             )
           LIMIT ${batchSize}
        )`,
      [String(graceDays)],
    );
    const n = deleteResult.rowCount ?? 0;
    counts.pruned += n;
    if (n < batchSize) break;
  }
  return counts;
}

export async function runSnapshotRetentionForCustomer(
  customerId: number,
  options: { batchSize?: number } = {},
): Promise<SnapshotRetentionCounts> {
  const batchSize = options.batchSize ?? DEFAULT_DELETE_BATCH_SIZE;
  const pool = await getCustomerPool(customerId);
  const counts = emptyCounts();

  const exclusionSweep = await sweepExclusionSnapshots(
    pool,
    SNAPSHOT_GRACE_DAYS,
    batchSize,
  );
  counts.exclusionSnapshotsTombstoned = exclusionSweep.tombstoned;
  counts.exclusionSnapshotsRevived = exclusionSweep.revived;
  counts.exclusionSnapshotsPruned = exclusionSweep.pruned;

  const policySweep = await sweepPolicySnapshots(
    pool,
    SNAPSHOT_GRACE_DAYS,
    batchSize,
  );
  counts.policySnapshotsTombstoned = policySweep.tombstoned;
  counts.policySnapshotsRevived = policySweep.revived;
  counts.policySnapshotsPruned = policySweep.pruned;

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
