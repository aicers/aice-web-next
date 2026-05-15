import "server-only";

/**
 * Snapshot writers (#472) — INSERT-once helpers that record the
 * canonical condition payload for a fingerprint the corpus runners
 * are about to reference.
 *
 * Three rules govern every writer:
 *
 *   1. The payload is canonicalized (sorted, fixed key order) so two
 *      independent captures of the same logical set produce
 *      byte-identical JSONB. This keeps `JSONB` cheap to diff and
 *      lets tests assert equality without normalization.
 *   2. The INSERT is `ON CONFLICT (<pk>) DO NOTHING`. The first writer
 *      wins; subsequent writers of the same fingerprint are no-ops.
 *      Diminished-semantics labels (`name_first_observed`,
 *      `scope_first_observed`) are recorded only by the winner.
 *   3. The writer is callable on either a `pg.Pool` or a `pg.PoolClient`
 *      so the caller chooses transaction scope. The corpus A pager
 *      writes inside its per-page transaction (so the snapshot row
 *      lands or rolls back with the events); the corpus B runner
 *      writes outside the run-insert auto-commit because
 *      `ON CONFLICT DO NOTHING` makes a snapshot row written for a
 *      later-aborted run safe to reuse on the next attempt.
 */

import type pg from "pg";

import type { StoredExclusionSnapshotInput } from "@/lib/triage/exclusion/types";
import type { TriagePolicyRow } from "@/lib/triage/policy/types";

import type {
  BaselineVersionParameters,
  ExclusionSnapshotPayload,
  PolicySnapshotPayload,
  PolicySnapshotRow,
} from "./types";

type Executor = Pick<pg.PoolClient, "query"> | Pick<pg.Pool, "query">;

/**
 * Canonicalize a list of exclusion snapshot rows: dedup by
 * `(kind, value)` keeping the first-seen `scope_first_observed`, then
 * sort by the stable `kind|value` serialization. Two independent
 * captures of the same logical set produce identical JSONB.
 *
 * The dedup mirrors `compileStoredRowsToActiveSet`'s behaviour — a
 * `(kind, value)` pair that exists in both global and customer scope
 * collapses to a single rule for the matcher AND to a single snapshot
 * row here, keyed by whichever scope appeared first in the input
 * ordering. Callers feed rows in a deterministic order
 * (global-then-customer) so the recorded scope label is stable across
 * cadence ticks.
 */
export function canonicalizeExclusionSnapshot(
  rows: ReadonlyArray<StoredExclusionSnapshotInput>,
): ExclusionSnapshotPayload {
  const seen = new Map<
    string,
    { scope_first_observed: "global" | "customer"; kind: string; value: string }
  >();
  for (const row of rows) {
    const key = `${row.kind}\x1f${row.value}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      scope_first_observed: row.scope,
      kind: row.kind,
      value: row.value,
    });
  }
  return Array.from(seen.values())
    .map((r) => ({
      scope_first_observed: r.scope_first_observed,
      kind: r.kind as StoredExclusionSnapshotInput["kind"],
      value: r.value,
    }))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
      if (a.value !== b.value) return a.value < b.value ? -1 : 1;
      return 0;
    });
}

/**
 * Write the exclusion snapshot for `fingerprint`. No-op if a row for
 * the same fingerprint already exists (first writer wins). Caller has
 * already computed the fingerprint with `computeExclusionsFingerprint`.
 */
export async function recordExclusionSnapshot(
  executor: Executor,
  fingerprint: string,
  rows: ReadonlyArray<StoredExclusionSnapshotInput>,
): Promise<void> {
  const payload = canonicalizeExclusionSnapshot(rows);
  await executor.query(
    `INSERT INTO exclusion_snapshot (fingerprint, snapshot)
          VALUES ($1, $2::jsonb)
       ON CONFLICT (fingerprint) DO NOTHING`,
    [fingerprint, JSON.stringify(payload)],
  );
}

/**
 * Canonicalize a list of triage policies into the policy-snapshot
 * payload: sort by `id`, drop `created_at` / `updated_at` (they
 * describe the policy row, not the run), rename `name` to
 * `name_first_observed` to encode diminished semantics.
 */
export function canonicalizePolicySnapshot(
  policies: ReadonlyArray<TriagePolicyRow>,
): PolicySnapshotPayload {
  const out: PolicySnapshotRow[] = policies.map((p) => ({
    id: p.id,
    name_first_observed: p.name,
    packet_attr: p.packet_attr,
    confidence: p.confidence,
    response: p.response,
  }));
  out.sort((a, b) => a.id - b.id);
  return out;
}

/**
 * Write the policy snapshot for `fingerprint`. No-op if a row for the
 * same fingerprint already exists; `name_first_observed` is therefore
 * the policy name as of the FIRST observation, not the current name.
 * Caller has already computed the fingerprint with
 * `computePoliciesFingerprint`.
 */
export async function recordPolicySnapshot(
  executor: Executor,
  fingerprint: string,
  policies: ReadonlyArray<TriagePolicyRow>,
): Promise<void> {
  const payload = canonicalizePolicySnapshot(policies);
  await executor.query(
    `INSERT INTO policy_snapshot (fingerprint, snapshot)
          VALUES ($1, $2::jsonb)
       ON CONFLICT (fingerprint) DO NOTHING`,
    [fingerprint, JSON.stringify(payload)],
  );
}

/**
 * Write the baseline parameters snapshot for `version`. No-op if a row
 * for the same version already exists. Per `tunables.ts` §10 every
 * value change requires a `baseline_version` bump, so a single row per
 * version is both sufficient and immutable in production. In tests
 * that swap in mock tunables a `version` collision still gets only
 * the first writer's payload — that's the right behaviour for both
 * the corpus A cadence and corpus B on-demand paths since they each
 * call this helper unconditionally before referencing the version.
 */
export async function recordBaselineVersionSnapshot(
  executor: Executor,
  version: string,
  parameters: BaselineVersionParameters,
): Promise<void> {
  await executor.query(
    `INSERT INTO baseline_version_snapshot (version, parameters)
          VALUES ($1, $2::jsonb)
       ON CONFLICT (version) DO NOTHING`,
    [version, JSON.stringify(parameters)],
  );
}
