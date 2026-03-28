import "server-only";

import { type NextRequest, NextResponse } from "next/server";

import {
  generateCorrelationId,
  withCorrelationId,
} from "@/lib/audit/correlation";
import { auditLog } from "@/lib/audit/logger";
import { isIpAllowed } from "@/lib/auth/cidr";
import { extractClientIp } from "@/lib/auth/ip";
import { loadMfaPolicy } from "@/lib/auth/mfa-policy";
import { verifyMfaToken } from "@/lib/auth/mfa-token";
import { loadSessionPolicy } from "@/lib/auth/session-policy";
import { createSessionAndIssueTokens } from "@/lib/auth/sign-in";
import { getTotpCredential, verifyTotpCode } from "@/lib/auth/totp";
import { query } from "@/lib/db/client";
import { checkMfaChallengeRateLimit } from "@/lib/rate-limit/limiter";

// ── Account row type ────────────────────────────────────────────

interface AccountRow {
  id: string;
  status: string;
  token_version: number;
  must_change_password: boolean;
  max_sessions: number | null;
  allowed_ips: string[] | null;
  role_name: string;
  locale: string | null;
}

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

  if (!/^\d{6}$/.test(code)) {
    return NextResponse.json(
      { error: "Code must be a 6-digit number" },
      { status: 400 },
    );
  }

  // Step 2: Verify mfaToken JWT
  let accountId: string;
  let jti: string;
  let roles: string[];
  let tokenVersion: number;

  try {
    const payload = await verifyMfaToken(mfaToken);
    accountId = payload.sub;
    jti = payload.jti;
    roles = payload.roles;
    tokenVersion = payload.token_version;
  } catch {
    return NextResponse.json(
      { error: "Invalid or expired MFA token", code: "MFA_TOKEN_INVALID" },
      { status: 401 },
    );
  }

  // Step 3: Check mfa_challenges table (exists, not used)
  const { rows: challengeRows } = await query<{ used: boolean }>(
    "SELECT used FROM mfa_challenges WHERE jti = $1",
    [jti],
  );

  if (challengeRows.length === 0 || challengeRows[0].used) {
    return NextResponse.json(
      { error: "Invalid or expired MFA token", code: "MFA_TOKEN_INVALID" },
      { status: 401 },
    );
  }

  // Step 4: Rate limit (after token verification — accountId is now trusted)
  const ip = extractClientIp(request);
  const rateResult = await checkMfaChallengeRateLimit(accountId, ip);
  if (rateResult.limited) {
    return NextResponse.json(
      { error: "Too many attempts", code: "MFA_RATE_LIMITED" },
      {
        status: 429,
        headers: { "Retry-After": String(rateResult.retryAfterSeconds) },
      },
    );
  }

  // Step 5: Policy check (TOTP may have been disabled mid-flow)
  const mfaPolicy = await loadMfaPolicy();
  if (!mfaPolicy.allowedMethods.includes("totp")) {
    return NextResponse.json(
      {
        error: "TOTP is no longer allowed",
        code: "TOTP_NOT_ALLOWED",
      },
      { status: 403 },
    );
  }

  // Step 6: Account state re-validation
  const { rows: accountRows } = await query<AccountRow>(
    `SELECT a.id, a.status, a.token_version, a.must_change_password,
            a.max_sessions, a.allowed_ips, r.name AS role_name, a.locale
     FROM accounts a
     JOIN roles r ON a.role_id = r.id
     WHERE a.id = $1`,
    [accountId],
  );

  if (accountRows.length === 0) {
    return NextResponse.json(
      { error: "Account not found", code: "MFA_TOKEN_INVALID" },
      { status: 401 },
    );
  }

  const account = accountRows[0];

  // 6a: Status check
  if (account.status === "locked") {
    return NextResponse.json(
      { error: "Account is locked", code: "ACCOUNT_LOCKED" },
      { status: 403 },
    );
  }

  if (account.status !== "active") {
    return NextResponse.json(
      { error: "Account is not active", code: "ACCOUNT_INACTIVE" },
      { status: 403 },
    );
  }

  // 6b: Token version check (password reset or sign-out-all invalidates)
  if (account.token_version !== tokenVersion) {
    return NextResponse.json(
      { error: "Token has been invalidated", code: "MFA_TOKEN_INVALID" },
      { status: 401 },
    );
  }

  // 6c: Role check
  if (!roles.includes(account.role_name)) {
    return NextResponse.json(
      { error: "Role has changed", code: "MFA_TOKEN_INVALID" },
      { status: 401 },
    );
  }

  // 6d: IP CIDR check
  if (!isIpAllowed(ip, account.allowed_ips ?? [])) {
    return NextResponse.json(
      { error: "Access denied from this network", code: "IP_RESTRICTED" },
      { status: 403 },
    );
  }

  // 6e: Max sessions check
  const sessionPolicy = await loadSessionPolicy();
  const effectiveMaxSessions =
    account.max_sessions ?? sessionPolicy.maxSessions;

  if (effectiveMaxSessions !== null) {
    const { rows: countRows } = await query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM sessions WHERE account_id = $1 AND revoked = false",
      [accountId],
    );
    const activeCount = Number(countRows[0].count);
    if (activeCount >= effectiveMaxSessions) {
      return NextResponse.json(
        {
          error: "Maximum number of active sessions reached",
          code: "MAX_SESSIONS",
        },
        { status: 403 },
      );
    }
  }

  // Step 7: Verify TOTP code
  const credential = await getTotpCredential(accountId);
  if (!credential?.verified) {
    return NextResponse.json(
      { error: "No TOTP credential found", code: "MFA_TOKEN_INVALID" },
      { status: 401 },
    );
  }

  const codeValid = verifyTotpCode(credential.secret, code);

  if (!codeValid) {
    await auditLog.record({
      actor: accountId,
      action: "mfa.totp.verify.failure",
      target: "mfa",
      targetId: accountId,
      ip,
    });
    return NextResponse.json(
      { error: "Invalid code", code: "INVALID_MFA_CODE" },
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
    action: "mfa.totp.verify.success",
    target: "mfa",
    targetId: accountId,
    ip,
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
