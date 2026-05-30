import "server-only";

import { NextResponse } from "next/server";

import { LIVE_BUCKET_DATE } from "@/lib/aimer/analysis/report-date";
import { resolveAnalysisSummaryResponse } from "@/lib/aimer/analysis/summary-route";
import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import { withAuth } from "@/lib/auth/guard";
import { hasPermission } from "@/lib/auth/permissions";

/**
 * `GET /api/aimer/analysis/reports/live/[customerId]/summary`
 *
 * LIVE (latest digest) report summary resolver for the dashboard card
 * (RFC 0002 Phase 2, aicers/aice-web-next#646). The dashboard fetches
 * this once per in-scope customer to decide whether to render the
 * "Latest digest" tier badge; the client treats anything other than
 * `200` as "no card".
 *
 * This is a thin wrapper mirroring the story route: parameter parsing
 * and tenant-scope concealment live here; the bridge-URL composition,
 * JWS attach, upstream fetch, field/link validation, and 200/204
 * mapping live in the shared {@link resolveAnalysisSummaryResponse}
 * helper (#653). The upstream resource path is
 * `/analysis/report/LIVE/1970-01-01/summary` — singular `report`,
 * uppercase period, LIVE pinned to the `1970-01-01` sentinel bucket.
 *
 * Surfaces:
 * - `200 OK` with the `{ exists: true, priority_tier, severity_score,
 *   likelihood_score, score_kind, link }` body when the upstream report
 *   exists, the tier is `CRITICAL` / `HIGH`, and `link` validated.
 * - `204 No Content` for every "render nothing" case (see the helper).
 * - `401` (no session — emitted by `withAuth`).
 * - `404 not_found` for cross-tenant `customerId` (concealment).
 */

export const GET = withAuth(
  async (_request, context, session) => {
    const { customerId: customerIdParam } = (await context.params) as {
      customerId?: string;
    };

    const customerId = Number(customerIdParam);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      return NextResponse.json(
        { error: "invalid_customer_id" },
        { status: 400 },
      );
    }

    // Tenant scope concealment — identical policy to the story route: a
    // non-admin probing a customer outside their scope gets a 404 so the
    // response is indistinguishable from "no such report".
    const isAdmin = await hasPermission(session.roles, "customers:access-all");
    if (!isAdmin) {
      const ids = await resolveEffectiveCustomerIds(
        session.accountId,
        session.roles,
      );
      if (!ids.includes(customerId)) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
    }

    return resolveAnalysisSummaryResponse({
      customerId,
      surface: "live",
      buildResourcePath: () =>
        `/analysis/report/LIVE/${LIVE_BUCKET_DATE}/summary`,
      logContext: `customerId=${customerId}`,
    });
  },
  {
    requiredPermissions: ["triage:read"],
  },
);
