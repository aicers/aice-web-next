import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/guard";
import { getSuspiciousAlerts } from "@/lib/dashboard/suspicious-activity";

/**
 * GET /api/dashboard/alerts
 *
 * Run suspicious activity detection rules and return alerts
 * sorted by severity.
 * Requires `dashboard:read` permission.
 */
export const GET = withAuth(
  async () => {
    const alerts = await getSuspiciousAlerts();
    return NextResponse.json({ data: alerts });
  },
  { requiredPermissions: ["dashboard:read"] },
);
