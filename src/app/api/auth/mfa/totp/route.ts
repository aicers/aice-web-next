import "server-only";

import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { getTotpCredential, removeTotp, verifyTotpCode } from "@/lib/auth/totp";

/**
 * DELETE /api/auth/mfa/totp
 *
 * Remove TOTP from the account. Requires a valid TOTP code to confirm.
 * Policy-independent — removal is always allowed.
 */
export const DELETE = withAuth(async (request, _context, session) => {
  // Step 1: Parse body
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

  // Step 2: Fetch verified credential
  const credential = await getTotpCredential(session.accountId);
  if (!credential?.verified) {
    return NextResponse.json(
      { error: "No TOTP credential found", code: "TOTP_NOT_FOUND" },
      { status: 404 },
    );
  }

  // Step 3: Verify code
  if (!verifyTotpCode(credential.secret, code)) {
    return NextResponse.json(
      { error: "Invalid TOTP code", code: "INVALID_CODE" },
      { status: 401 },
    );
  }

  // Step 4: Delete credential
  await removeTotp(session.accountId);

  // Step 5: Audit log
  await auditLog.record({
    actor: session.accountId,
    action: "mfa.totp.remove",
    target: "mfa",
    targetId: session.accountId,
    ip: extractClientIp(request),
    sid: session.sessionId,
  });

  return NextResponse.json({ success: true });
});
