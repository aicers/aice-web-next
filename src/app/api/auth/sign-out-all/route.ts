import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { deleteAccessTokenCookie } from "@/lib/auth/cookies";
import { CSRF_COOKIE_NAME } from "@/lib/auth/csrf";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { query } from "@/lib/db/client";

export const POST = withAuth(
  async (request, _context, session) => {
    // Increment token_version — invalidates all existing tokens
    await query(
      "UPDATE accounts SET token_version = token_version + 1 WHERE id = $1",
      [session.accountId],
    );

    // Clear current session cookies
    await deleteAccessTokenCookie();
    const cookieStore = await cookies();
    cookieStore.delete(CSRF_COOKIE_NAME);

    // Audit
    await auditLog.record({
      actor: session.accountId,
      action: "session.revoke",
      target: "account",
      targetId: session.accountId,
      ip: extractClientIp(request),
      sid: session.sessionId,
    });

    return NextResponse.json({ ok: true });
  },
  { skipPasswordCheck: true },
);
