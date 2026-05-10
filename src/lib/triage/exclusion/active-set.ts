/**
 * Active-exclusion-set resolver — pluggable storage adapter.
 *
 * Pre-#457 the helper resolves to the empty set; once #457 wires real
 * global / customer-scoped storage the same interface returns the
 * union of both scopes without changing the cadence runner. The
 * runner consumes the resolver through {@link ActiveExclusionSetResolver}
 * so a test can swap in a fake or pre-populated set.
 */

import type { ActiveExclusionSet } from "./types";

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
