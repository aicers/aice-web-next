import "server-only";

import { NextResponse } from "next/server";

import { isValidReportDate } from "@/lib/aimer/analysis/report-date";
import { resolveAnalysisSummaryResponse } from "@/lib/aimer/analysis/summary-route";
import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import { withAuth } from "@/lib/auth/guard";
import { hasPermission } from "@/lib/auth/permissions";

/**
 * `GET /api/aimer/analysis/reports/daily/[customerId]/[date]/summary`
 *
 * DAILY (today's report) summary resolver for the dashboard card (RFC
 * 0002 Phase 2, aicers/aice-web-next#646). The dashboard fetches this
 * once per in-scope customer for the viewer's local calendar day; the
 * client treats anything other than `200` as "no card".
 *
 * Thin wrapper mirroring the story / LIVE routes: parameter parsing,
 * the `[date]` calendar guard, and tenant-scope concealment live here;
 * everything else lives in {@link resolveAnalysisSummaryResponse}
 * (#653). The upstream resource path is
 * `/analysis/report/DAILY/{date}/summary` — singular `report`,
 * uppercase period.
 *
 * The `[date]` segment is validated with a strict `YYYY-MM-DD` calendar
 * check ({@link isValidReportDate}) — *not* `new Date(str)`, which
 * silently rolls over invalid dates and is timezone-affected. A failing
 * guard returns `400 invalid_report_date` locally before any upstream
 * call, mirroring the upstream `invalid_report_path` rule.
 *
 * Surfaces:
 * - `200 OK` with the summary body (see the helper).
 * - `204 No Content` for every "render nothing" case.
 * - `400 invalid_customer_id` / `invalid_report_date` for bad params.
 * - `401` (no session — emitted by `withAuth`).
 * - `404 not_found` for cross-tenant `customerId` (concealment).
 */

export const GET = withAuth(
  async (_request, context, session) => {
    const { customerId: customerIdParam, date: dateParam } =
      (await context.params) as { customerId?: string; date?: string };

    const customerId = Number(customerIdParam);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      return NextResponse.json(
        { error: "invalid_customer_id" },
        { status: 400 },
      );
    }
    if (!isValidReportDate(dateParam)) {
      return NextResponse.json(
        { error: "invalid_report_date" },
        { status: 400 },
      );
    }
    const date = dateParam;

    // Tenant scope concealment — identical policy to the story / LIVE
    // routes: a non-admin probing an out-of-scope customer gets a 404.
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
      surface: "daily",
      // `date` is already a strict `YYYY-MM-DD` literal, so it needs no
      // further encoding to form a single path segment.
      buildResourcePath: () => `/analysis/report/DAILY/${date}/summary`,
      logContext: `customerId=${customerId} date=${date}`,
    });
  },
  {
    requiredPermissions: ["triage:read"],
  },
);
