import "server-only";

import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/guard";
import { getRecoveryCodeCount } from "@/lib/auth/recovery-codes";

/**
 * Get the remaining recovery code count for the current user.
 */
export const GET = withAuth(async (_request, _context, session) => {
  const { remaining, total } = await getRecoveryCodeCount(session.accountId);
  return NextResponse.json({ remaining, total });
});
