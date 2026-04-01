import "server-only";

import { type NextRequest, NextResponse } from "next/server";

import {
  generateCorrelationId,
  withCorrelationId,
} from "@/lib/audit/correlation";
import { auditLog } from "@/lib/audit/logger";
import { validateMfaChallenge } from "@/lib/auth/mfa-challenge";
import { verifyRecoveryCode } from "@/lib/auth/recovery-codes";
import { createSessionAndIssueTokens } from "@/lib/auth/sign-in";
import { query } from "@/lib/db/client";

// ── Handler ─────────────────────────────────────────────────────

async function handleChallenge(request: NextRequest): Promise<NextResponse> {
  // Step 1: Parse body
  let body: { mfaToken?: string; code?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  const { mfaToken, code } = body;
  if (!mfaToken || !code) {
    return NextResponse.json(
      { error: "mfaToken and code are required" },
      { status: 400 },
    );
  }

  // Steps 2–6: Shared MFA challenge validation
  const result = await validateMfaChallenge(request, mfaToken);
  if (result instanceof NextResponse) return result;

  const { accountId, jti, account, ip } = result;

  // Step 7: Verify recovery code
  const codeValid = await verifyRecoveryCode(accountId, code);

  if (!codeValid) {
    await auditLog.record({
      actor: accountId,
      action: "mfa.recovery.use",
      target: "mfa",
      targetId: accountId,
      ip,
      details: { success: false },
    });
    return NextResponse.json(
      { error: "Invalid recovery code", code: "INVALID_MFA_CODE" },
      { status: 401 },
    );
  }

  // Step 8: Atomically consume token and create session
  const { rows: consumeRows } = await query<{ jti: string }>(
    "UPDATE mfa_challenges SET used = true WHERE jti = $1 AND used = false RETURNING jti",
    [jti],
  );

  if (consumeRows.length === 0) {
    return NextResponse.json(
      { error: "Token already used", code: "MFA_TOKEN_INVALID" },
      { status: 401 },
    );
  }

  await auditLog.record({
    actor: accountId,
    action: "mfa.recovery.use",
    target: "mfa",
    targetId: accountId,
    ip,
    details: { success: true },
  });

  const userAgent = request.headers.get("user-agent") ?? "";

  return createSessionAndIssueTokens({
    accountId,
    roleName: account.role_name,
    tokenVersion: account.token_version,
    mustChangePassword: account.must_change_password,
    locale: account.locale,
    ip,
    userAgent,
  });
}

// ── Route export ────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  const correlationId = generateCorrelationId();
  return withCorrelationId(correlationId, () => handleChallenge(request));
}
