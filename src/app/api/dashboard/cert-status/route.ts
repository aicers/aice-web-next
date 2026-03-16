import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/guard";
import { getCertStatus } from "@/lib/dashboard/cert-expiry";

/**
 * GET /api/dashboard/cert-status
 *
 * Return mTLS certificate expiry status. Returns
 * `{ configured: false }` when no certificate is configured.
 * Requires `dashboard:read` permission.
 */
export const GET = withAuth(
  async () => {
    const status = getCertStatus();
    return NextResponse.json({ data: status });
  },
  { requiredPermissions: ["dashboard:read"] },
);
