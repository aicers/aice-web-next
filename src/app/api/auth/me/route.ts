import "server-only";

import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/guard";
import { query } from "@/lib/db/client";

/**
 * GET /api/auth/me
 *
 * Returns current user info.  Rotation is triggered automatically
 * through `withAuth()` when the JWT is within the rotation window.
 */
export const GET = withAuth(async (_request, _context, session) => {
  const { rows } = await query<{
    username: string;
    display_name: string | null;
  }>("SELECT username, display_name FROM accounts WHERE id = $1", [
    session.accountId,
  ]);

  if (rows.length === 0) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  return NextResponse.json({
    accountId: session.accountId,
    username: rows[0].username,
    displayName: rows[0].display_name,
    roles: session.roles,
    mustChangePassword: session.mustChangePassword,
  });
});
