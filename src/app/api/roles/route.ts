import "server-only";

import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/guard";
import { query } from "@/lib/db/client";

interface RoleRow {
  id: number;
  name: string;
  description: string | null;
  is_builtin: boolean;
}

/**
 * GET /api/roles
 *
 * List all roles. No special permission required beyond being
 * authenticated — needed for account creation forms.
 */
export const GET = withAuth(async () => {
  const { rows } = await query<RoleRow>(
    "SELECT id, name, description, is_builtin FROM roles ORDER BY id",
  );
  return NextResponse.json({ data: rows });
});
