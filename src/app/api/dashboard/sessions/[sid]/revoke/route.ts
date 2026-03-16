import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { revokeSession } from "@/lib/auth/session";
import { query } from "@/lib/db/client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/dashboard/sessions/[sid]/revoke
 *
 * Force sign-out a session by revoking it.
 * Requires `dashboard:write` permission.
 */
export const POST = withAuth(
  async (request, context, session) => {
    const { sid } = await context.params;

    if (!UUID_RE.test(sid)) {
      return NextResponse.json(
        { error: "Invalid session ID format" },
        { status: 400 },
      );
    }

    // Verify the session exists and is not already revoked
    const { rows } = await query<{ sid: string; account_id: string }>(
      "SELECT sid, account_id FROM sessions WHERE sid = $1 AND revoked = false",
      [sid],
    );

    if (rows.length === 0) {
      return NextResponse.json(
        { error: "Session not found or already revoked" },
        { status: 404 },
      );
    }

    await revokeSession(sid);

    const ip = extractClientIp(request);
    await auditLog.record({
      actor: session.accountId,
      action: "session.revoke",
      target: "session",
      targetId: sid,
      ip,
      sid: session.sessionId,
      details: {
        targetAccountId: rows[0].account_id,
        revokedBy: "admin_dashboard",
      },
    });

    return NextResponse.json({ ok: true });
  },
  { requiredPermissions: ["dashboard:write"] },
);
