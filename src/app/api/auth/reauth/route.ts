import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { verifyPassword } from "@/lib/auth/password";
import { extractBrowserFingerprint } from "@/lib/auth/ua-parser";
import { query } from "@/lib/db/client";

export const POST = withAuth(
  async (request, _context, session) => {
    // Step 1: Parse body — requires password
    let body: { password?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 },
      );
    }

    const { password } = body;
    if (!password) {
      return NextResponse.json(
        { error: "Password is required" },
        { status: 400 },
      );
    }

    // Step 2: Fetch account password hash
    const { rows } = await query<{ password_hash: string }>(
      "SELECT password_hash FROM accounts WHERE id = $1",
      [session.accountId],
    );

    if (rows.length === 0) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    const ip = extractClientIp(request);
    const userAgent = request.headers.get("user-agent") ?? "";

    // Step 3: Verify password
    const passwordValid = await verifyPassword(rows[0].password_hash, password);
    if (!passwordValid) {
      await auditLog.record({
        actor: session.accountId,
        action: "session.reauth_failure",
        target: "session",
        targetId: session.sessionId,
        ip,
        sid: session.sessionId,
        details: { reason: "invalid_password" },
      });
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }

    // Step 4: Success — clear needs_reauth, update stored IP/UA
    const browserFingerprint = extractBrowserFingerprint(userAgent);

    await query(
      `UPDATE sessions
       SET needs_reauth = false,
           ip_address = $2,
           user_agent = $3,
           browser_fingerprint = $4
       WHERE sid = $1`,
      [session.sessionId, ip, userAgent, browserFingerprint],
    );

    await auditLog.record({
      actor: session.accountId,
      action: "session.reauth_success",
      target: "session",
      targetId: session.sessionId,
      ip,
      sid: session.sessionId,
    });

    return NextResponse.json({ ok: true });
  },
  {
    skipPasswordCheck: true,
    skipMfaEnrollCheck: true,
    skipSessionPolicy: true,
  },
);
