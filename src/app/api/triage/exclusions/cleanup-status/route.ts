import "server-only";

import { type NextRequest, NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/guard";
import { hasPermission } from "@/lib/auth/permissions";
import { query } from "@/lib/db/client";
import { listAuditOnlyCustomerDrainFailures } from "@/lib/triage/exclusion/recovery";

/**
 * GET /api/triage/exclusions/cleanup-status?customer_id=<id>
 *
 * Returns the list of customer-scoped triage exclusion ids whose
 * retroactive cleanup is in a recoverable failed state. The admin UI
 * uses this to surface a "Re-trigger cleanup" affordance only for the
 * rows that actually need it (vs every row).
 *
 * Two sources are unioned:
 *
 *   1. `failed` sentinel rows in the auth_db fanout queue — the normal
 *      drain-failure path enqueues these via
 *      `insertCustomerDrainFailureSentinel`.
 *   2. Audit-only drain failures — `triage_exclusion.customer_add`
 *      audit rows with `details.drainStatus='failed'` and no later
 *      `triage_exclusion.customer_recover` audit row. This is the
 *      fallback for the case where the failed ADD path's sentinel
 *      insert itself failed (auth_db blip) and the failure was
 *      swallowed so the primary drain error remained visible in the
 *      500 response. Without this fallback the exclusion would be
 *      permanently unrecoverable from the UI.
 *
 * Gated on `triage:read` plus the caller's effective customer scope —
 * same predicate as `GET /api/triage/exclusions`. The failed-row list
 * itself is per-customer, so a caller whose scope excludes
 * `customer_id` cannot enumerate sentinels for that tenant.
 */
export const GET = withAuth(
  async (request, _context, session) => {
    const customerId = parseCustomerId(request);
    if (customerId === null) {
      return NextResponse.json(
        { error: "Missing or invalid customer_id" },
        { status: 400 },
      );
    }
    if (
      !(await callerCanAccessCustomer(
        session.accountId,
        session.roles,
        customerId,
      ))
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { rows } = await query<{ customer_only_exclusion_id: string }>(
      `SELECT customer_only_exclusion_id
         FROM triage_exclusion_fanout_job
        WHERE customer_id = $1
          AND customer_only_exclusion_id IS NOT NULL
          AND status = 'failed'`,
      [customerId],
    );
    const auditOnly = await listAuditOnlyCustomerDrainFailures(customerId);
    const failed = new Set<string>();
    for (const r of rows) failed.add(r.customer_only_exclusion_id);
    for (const id of auditOnly) failed.add(id);
    return NextResponse.json({ failed: Array.from(failed) });
  },
  { requiredPermissions: ["triage:read"] },
);

function parseCustomerId(request: NextRequest): number | null {
  const raw = request.nextUrl.searchParams.get("customer_id");
  if (raw === null) return null;
  const id = Number(raw);
  if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) return null;
  return id;
}

async function callerCanAccessCustomer(
  accountId: string,
  roles: string[],
  customerId: number,
): Promise<boolean> {
  if (await hasPermission(roles, "customers:access-all")) return true;
  const { rows } = await query<{ customer_id: number }>(
    "SELECT customer_id FROM account_customer WHERE account_id = $1 AND customer_id = $2",
    [accountId, customerId],
  );
  return rows.length > 0;
}
