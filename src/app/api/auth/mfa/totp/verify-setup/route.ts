import "server-only";

import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { loadMfaPolicy } from "@/lib/auth/mfa-policy";
import {
  generateRecoveryCodes,
  getRecoveryCodeCount,
} from "@/lib/auth/recovery-codes";
import {
  activateTotp,
  getTotpCredential,
  verifyTotpCode,
} from "@/lib/auth/totp";

/**
 * POST /api/auth/mfa/totp/verify-setup
 *
 * Complete TOTP enrollment by verifying the first code.
 */
export const POST = withAuth(
  async (request, _context, session) => {
    // Step 1: Check MFA policy allows TOTP
    const policy = await loadMfaPolicy();
    if (!policy.allowedMethods.includes("totp")) {
      return NextResponse.json(
        { error: "TOTP is not allowed by policy", code: "TOTP_NOT_ALLOWED" },
        { status: 405 },
      );
    }

    // Step 2: Parse body
    let code: string;
    try {
      const body = await request.json();
      code = body.code;
      if (!code) {
        return NextResponse.json(
          { error: "Missing required field: code" },
          { status: 400 },
        );
      }
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // Step 3: Fetch unverified credential
    const credential = await getTotpCredential(session.accountId);
    if (!credential || credential.verified) {
      return NextResponse.json(
        { error: "No pending TOTP setup found", code: "TOTP_NOT_FOUND" },
        { status: 404 },
      );
    }

    // Step 4: Verify the code
    if (!verifyTotpCode(credential.secret, code)) {
      return NextResponse.json(
        { error: "Invalid TOTP code", code: "INVALID_CODE" },
        { status: 401 },
      );
    }

    // Step 5: Activate the specific credential we validated
    const activated = await activateTotp(credential.id);
    if (!activated) {
      return NextResponse.json(
        {
          error: "TOTP setup was replaced, please start over",
          code: "TOTP_NOT_FOUND",
        },
        { status: 404 },
      );
    }

    // Step 6: Audit log
    await auditLog.record({
      actor: session.accountId,
      action: "mfa.totp.enroll",
      target: "mfa",
      targetId: session.accountId,
      ip: extractClientIp(request),
      sid: session.sessionId,
    });

    // Step 7: Auto-generate recovery codes if first MFA method
    const { total } = await getRecoveryCodeCount(session.accountId);
    if (total === 0) {
      const recoveryCodes = await generateRecoveryCodes(session.accountId);

      await auditLog.record({
        actor: session.accountId,
        action: "mfa.recovery.generate",
        target: "mfa",
        targetId: session.accountId,
        ip: extractClientIp(request),
        sid: session.sessionId,
        details: { reason: "auto_first_enrollment" },
      });

      return NextResponse.json({ success: true, recoveryCodes });
    }

    return NextResponse.json({ success: true });
  },
  { skipMfaEnrollCheck: true },
);
