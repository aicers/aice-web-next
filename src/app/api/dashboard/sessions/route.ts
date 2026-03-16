import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/guard";
import { getActiveSessions } from "@/lib/dashboard/queries";

/**
 * GET /api/dashboard/sessions
 *
 * List all active (non-revoked) sessions with account info.
 * Requires `dashboard:read` permission.
 */
export const GET = withAuth(
  async () => {
    const sessions = await getActiveSessions();
    return NextResponse.json({ data: sessions });
  },
  { requiredPermissions: ["dashboard:read"] },
);
