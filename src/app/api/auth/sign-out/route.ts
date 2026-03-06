import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import {
  deleteAccessTokenCookie,
  deleteTokenExpCookie,
} from "@/lib/auth/cookies";
import { CSRF_COOKIE_NAME } from "@/lib/auth/csrf";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { revokeSession } from "@/lib/auth/session";

export const POST = withAuth(
  async (request, _context, session) => {
    // Revoke current session
    await revokeSession(session.sessionId);

    // Clear cookies
    await deleteAccessTokenCookie();
    await deleteTokenExpCookie();
    const cookieStore = await cookies();
    cookieStore.delete(CSRF_COOKIE_NAME);

    // Audit
    await auditLog.record({
      actor: session.accountId,
      action: "auth.sign_out",
      target: "session",
      targetId: session.sessionId,
      ip: extractClientIp(request),
      sid: session.sessionId,
    });

    return NextResponse.json({ ok: true });
  },
  { skipPasswordCheck: true },
);
