import "server-only";

import { randomUUID } from "node:crypto";

import { type NextRequest, NextResponse } from "next/server";

import {
  generateCorrelationId,
  withCorrelationId,
} from "@/lib/audit/correlation";
import { auditLog } from "@/lib/audit/logger";
import { isIpAllowed } from "@/lib/auth/cidr";
import { extractClientIp } from "@/lib/auth/ip";
import { loadLockoutPolicy } from "@/lib/auth/lockout-policy";
import { getMfaRequirement } from "@/lib/auth/mfa-enforcement";
import { loadMfaPolicy } from "@/lib/auth/mfa-policy";
import { issueMfaToken } from "@/lib/auth/mfa-token";
import { verifyPassword } from "@/lib/auth/password";
import { loadSessionPolicy } from "@/lib/auth/session-policy";
import { createSessionAndIssueTokens } from "@/lib/auth/sign-in";
import { getTotpCredential } from "@/lib/auth/totp";
import { getWebAuthnCredentials } from "@/lib/auth/webauthn";
import { query } from "@/lib/db/client";
import { checkSignInRateLimit } from "@/lib/rate-limit/limiter";

// ── Account row type ────────────────────────────────────────────

interface AccountRow {
  id: string;
  password_hash: string;
  status: string;
  token_version: number;
  must_change_password: boolean;
  mfa_override: string | null;
  failed_sign_in_count: number;
  lockout_count: number;
  locked_until: string | null;
  max_sessions: number | null;
  allowed_ips: string[] | null;
  role_name: string;
  role_mfa_required: boolean;
  locale: string | null;
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Validate account lockout and status. Auto-unlocks expired temporary locks.
 * Mutates account fields when auto-unlocking.
 *
 * @returns An error response if the account cannot proceed, or `null` if OK.
 */
async function validateAccountStatus(
  account: AccountRow,
  ip: string,
): Promise<NextResponse | null> {
  if (account.status === "locked") {
    if (account.locked_until === null) {
      await auditLog.record({
        actor: account.id,
        action: "auth.sign_in.failure",
        target: "account",
        targetId: account.id,
        details: { reason: "account_locked", ip },
      });
      return NextResponse.json(
        { error: "Account is locked", code: "ACCOUNT_LOCKED" },
        { status: 403 },
      );
    }

    const lockExpiry = new Date(account.locked_until);
    if (lockExpiry > new Date()) {
      await auditLog.record({
        actor: account.id,
        action: "auth.sign_in.failure",
        target: "account",
        targetId: account.id,
        details: { reason: "account_locked", ip },
      });
      return NextResponse.json(
        { error: "Account is locked", code: "ACCOUNT_LOCKED" },
        { status: 403 },
      );
    }

    // Temporary lock expired — auto-unlock
    await query(
      `UPDATE accounts
       SET status = 'active', failed_sign_in_count = 0, locked_until = NULL
       WHERE id = $1`,
      [account.id],
    );
    account.status = "active";
    account.failed_sign_in_count = 0;
    account.locked_until = null;
  }

  if (account.status !== "active") {
    await auditLog.record({
      actor: account.id,
      action: "auth.sign_in.failure",
      target: "account",
      targetId: account.id,
      details: { reason: "account_inactive", status: account.status, ip },
    });
    return NextResponse.json(
      { error: "Account is not active", code: "ACCOUNT_INACTIVE" },
      { status: 403 },
    );
  }

  return null;
}

/**
 * Handle a failed password attempt: increment failure count,
 * apply lockout stages, and log the event.
 */
async function applyFailedLogin(
  account: AccountRow,
  ip: string,
): Promise<NextResponse> {
  const newFailCount = account.failed_sign_in_count + 1;
  const lockout = await loadLockoutPolicy();

  if (newFailCount >= lockout.stage1Threshold) {
    if (account.lockout_count >= 1) {
      // Stage 2 — suspend (no auto-recovery)
      await query(
        `UPDATE accounts
         SET failed_sign_in_count = $1, status = 'suspended',
             locked_until = NULL
         WHERE id = $2`,
        [newFailCount, account.id],
      );
      await auditLog.record({
        actor: account.id,
        action: "account.suspend",
        target: "account",
        targetId: account.id,
        details: {
          reason: "stage2_suspended",
          failedCount: newFailCount,
          lockoutCount: account.lockout_count,
          ip,
        },
      });
    } else {
      // Stage 1 — temporary lock
      await query(
        `UPDATE accounts
         SET failed_sign_in_count = $1, status = 'locked',
             locked_until = NOW() + $2 * INTERVAL '1 minute',
             lockout_count = lockout_count + 1
         WHERE id = $3`,
        [newFailCount, lockout.stage1DurationMinutes, account.id],
      );
      await auditLog.record({
        actor: account.id,
        action: "account.lock",
        target: "account",
        targetId: account.id,
        details: {
          reason: "stage1_temporary",
          failedCount: newFailCount,
          durationMinutes: lockout.stage1DurationMinutes,
          ip,
        },
      });
    }
  } else {
    // Below threshold — just increment
    await query("UPDATE accounts SET failed_sign_in_count = $1 WHERE id = $2", [
      newFailCount,
      account.id,
    ]);
  }

  await auditLog.record({
    actor: account.id,
    action: "auth.sign_in.failure",
    target: "account",
    targetId: account.id,
    details: { reason: "invalid_credentials", ip },
  });

  return NextResponse.json(
    { error: "Invalid credentials", code: "INVALID_CREDENTIALS" },
    { status: 401 },
  );
}

// ── Handler ─────────────────────────────────────────────────────

async function handleSignIn(request: NextRequest): Promise<NextResponse> {
  // Step 1: Parse body
  let body: { username?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  const { username, password } = body;
  if (!username || !password) {
    return NextResponse.json(
      { error: "Username and password are required" },
      { status: 400 },
    );
  }

  const ip = extractClientIp(request);
  const userAgent = request.headers.get("user-agent") ?? "";

  // Step 2: Rate limit
  const rateResult = await checkSignInRateLimit(ip, username);
  if (rateResult.limited) {
    await auditLog.record({
      actor: username,
      action: "auth.sign_in.failure",
      target: "account",
      details: { reason: "rate_limited", ip },
    });
    return NextResponse.json(
      { error: "Too many sign-in attempts" },
      {
        status: 429,
        headers: { "Retry-After": String(rateResult.retryAfterSeconds) },
      },
    );
  }

  // Step 3: Fetch account
  const { rows: accountRows } = await query<AccountRow>(
    `SELECT a.id, a.password_hash, a.status, a.token_version,
            a.must_change_password, a.mfa_override,
            a.failed_sign_in_count, a.lockout_count, a.locked_until,
            a.max_sessions, a.allowed_ips,
            r.name AS role_name, r.mfa_required AS role_mfa_required,
            a.locale
     FROM accounts a
     JOIN roles r ON a.role_id = r.id
     WHERE a.username = $1`,
    [username],
  );

  if (accountRows.length === 0) {
    await auditLog.record({
      actor: username,
      action: "auth.sign_in.failure",
      target: "account",
      details: { reason: "invalid_credentials", ip },
    });
    return NextResponse.json(
      { error: "Invalid credentials", code: "INVALID_CREDENTIALS" },
      { status: 401 },
    );
  }

  const account = accountRows[0];

  // Step 4: Account status and lockout
  const statusError = await validateAccountStatus(account, ip);
  if (statusError) return statusError;

  // Step 5: CIDR check
  if (!isIpAllowed(ip, account.allowed_ips ?? [])) {
    await auditLog.record({
      actor: account.id,
      action: "auth.sign_in.failure",
      target: "account",
      targetId: account.id,
      details: { reason: "ip_restricted", ip },
    });
    return NextResponse.json(
      { error: "Access denied from this network", code: "IP_RESTRICTED" },
      { status: 403 },
    );
  }

  // Step 6: Password verification
  const passwordValid = await verifyPassword(account.password_hash, password);
  if (!passwordValid) {
    return applyFailedLogin(account, ip);
  }

  // Step 6.5: MFA check (credential + policy dual check)
  const mfaPolicy = await loadMfaPolicy();
  const mfaMethods: string[] = [];

  const totpCredential = await getTotpCredential(account.id);
  if (totpCredential?.verified && mfaPolicy.allowedMethods.includes("totp")) {
    mfaMethods.push("totp");
  }

  const webauthnCreds = await getWebAuthnCredentials(account.id);
  if (
    webauthnCreds.length > 0 &&
    mfaPolicy.allowedMethods.includes("webauthn")
  ) {
    mfaMethods.push("webauthn");
  }

  if (mfaMethods.length > 0) {
    const jti = randomUUID();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await query(
      "INSERT INTO mfa_challenges (jti, account_id, expires_at) VALUES ($1, $2, $3)",
      [jti, account.id, expiresAt],
    );
    const mfaToken = await issueMfaToken({
      accountId: account.id,
      roles: [account.role_name],
      tokenVersion: account.token_version,
      jti,
    });
    return NextResponse.json({
      mfaRequired: true,
      mfaToken,
      mfaMethods,
    });
  }

  // Step 6.6: MFA enforcement — required but not enrolled
  const mfaRequirement = getMfaRequirement(
    account.mfa_override,
    account.role_mfa_required,
  );
  const mustEnrollMfa = mfaRequirement === "required";

  if (mustEnrollMfa) {
    await auditLog.record({
      actor: account.id,
      action: "mfa.enforcement.blocked",
      target: "mfa",
      targetId: account.id,
      ip,
      details: { reason: "not_enrolled" },
    });
  }

  // Step 7: Max sessions check
  const policy = await loadSessionPolicy();
  const effectiveMaxSessions = account.max_sessions ?? policy.maxSessions;

  if (effectiveMaxSessions !== null) {
    const { rows: countRows } = await query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM sessions WHERE account_id = $1 AND revoked = false",
      [account.id],
    );
    const activeCount = Number(countRows[0].count);
    if (activeCount >= effectiveMaxSessions) {
      await auditLog.record({
        actor: account.id,
        action: "auth.sign_in.failure",
        target: "account",
        targetId: account.id,
        details: {
          reason: "max_sessions",
          activeCount,
          limit: effectiveMaxSessions,
          ip,
        },
      });
      return NextResponse.json(
        {
          error: "Maximum number of active sessions reached",
          code: "MAX_SESSIONS",
        },
        { status: 403 },
      );
    }
  }

  // Step 8: Create session and issue tokens
  return createSessionAndIssueTokens({
    accountId: account.id,
    roleName: account.role_name,
    tokenVersion: account.token_version,
    mustChangePassword: account.must_change_password,
    mustEnrollMfa,
    locale: account.locale,
    ip,
    userAgent,
  });
}

// ── Route export ────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  const correlationId = generateCorrelationId();
  return withCorrelationId(correlationId, () => handleSignIn(request));
}
