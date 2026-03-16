import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/guard";
import { getLockedSuspendedAccounts } from "@/lib/dashboard/queries";

/**
 * GET /api/dashboard/locked-accounts
 *
 * List accounts with `locked` or `suspended` status.
 * Requires `dashboard:read` permission.
 */
export const GET = withAuth(
  async () => {
    const accounts = await getLockedSuspendedAccounts();
    return NextResponse.json({ data: accounts });
  },
  { requiredPermissions: ["dashboard:read"] },
);
