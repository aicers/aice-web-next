import "server-only";

import { compileStoredRowsToActiveSet } from "./active-set";
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
