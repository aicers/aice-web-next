import "server-only";

import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { isUserMfaEnrolled } from "@/lib/auth/mfa-enforcement";
import { query } from "@/lib/db/client";

export const POST = withAuth(
  async (request, _context, session) => {
    const enrolled = await isUserMfaEnrolled(session.accountId);
    if (!enrolled) {
      return NextResponse.json(
        { error: "No MFA method enrolled" },
        { status: 400 },
      );
    }

    await query("UPDATE sessions SET must_enroll_mfa = false WHERE sid = $1", [
      session.sessionId,
    ]);

    const ip = extractClientIp(request);
    await auditLog.record({
      actor: session.accountId,
      action: "mfa.enrollment.complete",
      target: "mfa",
      targetId: session.accountId,
      ip,
      sid: session.sessionId,
    });

    return NextResponse.json({ success: true });
  },
  { skipMfaEnrollCheck: true },
);
