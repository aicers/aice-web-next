import "server-only";

import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { verifyPassword } from "@/lib/auth/password";
import { generateRecoveryCodes } from "@/lib/auth/recovery-codes";
import { query } from "@/lib/db/client";
import { checkSensitiveOpRateLimit } from "@/lib/rate-limit/limiter";

/**
 * Generate or regenerate recovery codes.
 * Requires current password confirmation.
 */
export const POST = withAuth(
  async (request, _context, session) => {
    // Step 1: Parse body
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

    // Step 2: Rate limit
    const ip = extractClientIp(request);
    const rateResult = await checkSensitiveOpRateLimit(session.accountId);
    if (rateResult.limited) {
      return NextResponse.json(
        { error: "Too many attempts" },
        {
          status: 429,
          headers: { "Retry-After": String(rateResult.retryAfterSeconds) },
        },
      );
    }

    // Step 3: Verify current password
    const { rows } = await query<{ password_hash: string }>(
      "SELECT password_hash FROM accounts WHERE id = $1",
      [session.accountId],
    );

    if (rows.length === 0) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    const valid = await verifyPassword(rows[0].password_hash, password);
    if (!valid) {
      return NextResponse.json(
        { error: "Incorrect password", code: "INCORRECT_PASSWORD" },
        { status: 401 },
      );
    }

    // Step 4: Generate codes
    const codes = await generateRecoveryCodes(session.accountId);

    await auditLog.record({
      actor: session.accountId,
      action: "mfa.recovery.generate",
      target: "mfa",
      targetId: session.accountId,
      ip,
      sid: session.sessionId,
    });

    return NextResponse.json({ codes });
  },
  { skipMfaEnrollCheck: true },
);
