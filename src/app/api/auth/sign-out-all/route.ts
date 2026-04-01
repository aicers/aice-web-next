import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import {
  deleteAccessTokenCookie,
  deleteTokenExpCookie,
  deleteTokenTtlCookie,
} from "@/lib/auth/cookies";
import { CSRF_COOKIE_NAME } from "@/lib/auth/csrf";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { withTransaction } from "@/lib/db/client";

export const POST = withAuth(
  async (request, _context, session) => {
    await withTransaction(async (client) => {
      // Keep JWT invalidation and DB-backed session revocation atomic so
      // session limits and dashboard state update immediately.
      await client.query(
        "UPDATE accounts SET token_version = token_version + 1 WHERE id = $1",
        [session.accountId],
      );
      await client.query(
        `UPDATE sessions SET revoked = true
         WHERE account_id = $1 AND revoked = false`,
        [session.accountId],
      );
    });

    // Clear current session cookies
    await deleteAccessTokenCookie();
    await deleteTokenExpCookie();
    await deleteTokenTtlCookie();
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
  { skipPasswordCheck: true, skipMfaEnrollCheck: true },
);
