import "server-only";

import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/guard";
import { query } from "@/lib/db/client";

/**
 * GET /api/triage/exclusions/global/cleanup-status
 *
 * Returns the set of global exclusion ids with at least one `failed`
 * fanout row, so the admin UI can surface the "Re-trigger cleanup"
 * affordance only for rows that need it. The UI's sweep is keyed by
 * exclusion id (per-customer pinpointing remains available via the
 * internal-token route), so this endpoint does not expose the per-
 * exclusion customer-id list — that detail is operator-scoped and
 * lives behind the internal route.
 *
 * Gated on `triage:read`.
 */
export const GET = withAuth(
  async (_request, _context, _session) => {
    const { rows } = await query<{ global_exclusion_id: string }>(
      `SELECT DISTINCT global_exclusion_id
         FROM triage_exclusion_fanout_job
        WHERE global_exclusion_id IS NOT NULL
          AND status = 'failed'`,
    );
    return NextResponse.json({
      failed: rows.map((r) => r.global_exclusion_id),
    });
  },
  { requiredPermissions: ["triage:read"] },
);
