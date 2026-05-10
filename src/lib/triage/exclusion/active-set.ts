/**
 * Active-exclusion-set resolver — pluggable storage adapter.
 *
 * Pre-#457 the helper resolves to the empty set; once #457 wires real
 * global / customer-scoped storage the same interface returns the
 * union of both scopes without changing the cadence runner. The
 * runner consumes the resolver through {@link ActiveExclusionSetResolver}
 * so a test can swap in a fake or pre-populated set.
 *
 * Two resolvers ship in this module:
 *   - {@link EMPTY_EXCLUSION_SET_RESOLVER} — the empty-set default
 *     (kept for backward compatibility and for tests that want to
 *     bypass storage entirely).
 *   - {@link STORAGE_EXCLUSION_SET_RESOLVER} — reads the real union
 *     from `auth_db.global_triage_exclusion` and the tenant DB's
 *     `triage_exclusion`, then compiles each row into a single-field
 *     {@link ExclusionRule} so downstream `matchEvent` /
 *     `computeExclusionsFingerprint` see the same shape they do for
 *     the inline GraphQL `EventTriageExclusionInput` path. Wired in
 *     once aicers/review-web#842 lands the production pager.
 */

import type { ActiveExclusionSet, ExclusionRule } from "./types";

export interface ActiveExclusionSetResolver {
  /**
   * Resolve the active exclusion set for one customer. Implementations
   * MUST return a fresh array per call so the cadence runner is free
   * to mutate / cache it locally without affecting other callers.
   */
  resolve(customerId: number): Promise<ActiveExclusionSet>;
}

/**
 * Default resolver. Returns the empty set for every customer. The
 * cadence runner therefore behaves as a no-op exclusion pass-through
 * pre-#457; the `exclusions_fp` column carries
 * {@link EMPTY_EXCLUSIONS_FINGERPRINT} so the schema's NOT NULL
 * constraint is satisfied with a real value (not NULL) and the rows
 * already on disk re-key cleanly when #457 lands and the resolver
 * starts returning real rules.
 */
export const EMPTY_EXCLUSION_SET_RESOLVER: ActiveExclusionSetResolver = {
  async resolve(): Promise<ActiveExclusionSet> {
    return { rules: [] };
  },
};

/**
 * Compile a flat list of stored rows into the {@link ActiveExclusionSet}
 * the matcher consumes. One row → one single-field
 * {@link ExclusionRule}. Pure; safe to call from non-server code if
 * the rows are already loaded.
 *
 * `ipAddress` rows carry a single canonical CIDR per row (or
 * `host/32`, `host/128` for single IPs); the matcher treats `/32` and
 * `/128` as exact-host containment via `cidrContains`, which gives
 * the same behaviour as if the row had been put into
 * {@link IpAddressExclusionInput.hosts}.
 */
export function compileStoredRowsToActiveSet(
  rows: readonly {
    kind: "ipAddress" | "hostname" | "uri" | "domain";
    value: string;
  }[],
): ActiveExclusionSet {
  // Dedup `(kind, value)` pairs so a row that exists in both
  // `auth_db.global_triage_exclusion` and the tenant DB's
  // `triage_exclusion` produces a single rule. Without this dedup the
  // matcher behaviour is unchanged (both rules fire identically), but
  // `computeExclusionsFingerprint` would see two equal rules and
  // produce a different digest than for one — drifting the corpus
  // freshness signal mid-tick when ops moves a customer-only exclusion
  // to global. Spec acceptance criterion: "downstream matching
  // de-duplicates" (issue #457).
  const seen = new Set<string>();
  const rules: ExclusionRule[] = [];
  for (const row of rows) {
    const key = `${row.kind}\x1f${row.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    switch (row.kind) {
      case "ipAddress": {
        rules.push({
          ipAddress: { hosts: [], networks: [row.value], ranges: [] },
        });
        break;
      }
      case "hostname": {
        rules.push({ hostname: [row.value] });
        break;
      }
      case "uri": {
        rules.push({ uri: [row.value] });
        break;
      }
      case "domain": {
        rules.push({ domain: [row.value] });
        break;
      }
    }
  }
  return { rules };
}
