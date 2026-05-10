import "server-only";

import {
  type ActiveExclusionSetResolver,
  compileStoredRowsToActiveSet,
} from "./active-set";
import { loadActiveExclusionRows } from "./storage";
import type { ActiveExclusionSet } from "./types";

/**
 * Production resolver — reads `auth_db.global_triage_exclusion` and
 * the tenant DB's `triage_exclusion`, then compiles them into a
 * single-field-per-row {@link ActiveExclusionSet}. Consumed by the
 * cadence runner step (c) once aicers/review-web#842 lands the
 * production pager.
 */
export async function loadActiveExclusions(
  customerId: number,
): Promise<ActiveExclusionSet> {
  const rows = await loadActiveExclusionRows(customerId);
  return compileStoredRowsToActiveSet(rows);
}

/**
 * `ActiveExclusionSetResolver` adapter for the storage-backed loader.
 * The internal cadence route wires this into the production pager so
 * cadence step (c) honours newly-added global / customer-scoped
 * exclusions on the next tick — without it, the pager defaults to
 * `EMPTY_EXCLUSION_SET_RESOLVER` and ignores stored rows.
 */
export const STORAGE_EXCLUSION_SET_RESOLVER: ActiveExclusionSetResolver = {
  async resolve(customerId: number): Promise<ActiveExclusionSet> {
    return loadActiveExclusions(customerId);
  },
};
