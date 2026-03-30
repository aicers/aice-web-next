import "server-only";

import { type NextRequest, NextResponse } from "next/server";

import { isIpAllowed } from "@/lib/auth/cidr";
import { extractClientIp } from "@/lib/auth/ip";
import type { MfaTokenPayload } from "@/lib/auth/mfa-token";
import { verifyMfaToken } from "@/lib/auth/mfa-token";
import { loadSessionPolicy } from "@/lib/auth/session-policy";
import { query } from "@/lib/db/client";
import { checkMfaChallengeRateLimit } from "@/lib/rate-limit/limiter";

// ── Types ────────────────────────────────────────────────────────

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

export interface MfaChallengeContext {
  accountId: string;
  jti: string;
  roles: string[];
  tokenVersion: number;
  account: AccountRow;
  ip: string;
}

// ── Shared validation ────────────────────────────────────────────

/**
 * Validate an MFA challenge request: verify JWT, check the challenge
 * record, apply rate limiting, and re-validate account state.
 *
 * Returns the validated context on success, or a NextResponse on failure.
 */
export async function validateMfaChallenge(
  request: NextRequest,
  mfaToken: string,
): Promise<MfaChallengeContext | NextResponse> {
  // Step 1: Verify mfaToken JWT
  let payload: MfaTokenPayload;
  try {
    payload = await verifyMfaToken(mfaToken);
  } catch {
    return NextResponse.json(
      { error: "Invalid or expired MFA token", code: "MFA_TOKEN_INVALID" },
      { status: 401 },
    );
  }

  const { sub: accountId, jti, roles, token_version: tokenVersion } = payload;

  // Step 2: Check mfa_challenges table (exists, not used)
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

  // Step 3: Rate limit (after token verification — accountId is now trusted)
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

  // Step 4: Account state re-validation
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

  // 4a: Status check
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

  // 4b: Token version check (password reset or sign-out-all invalidates)
  if (account.token_version !== tokenVersion) {
    return NextResponse.json(
      { error: "Token has been invalidated", code: "MFA_TOKEN_INVALID" },
      { status: 401 },
    );
  }

  // 4c: Role check
  if (!roles.includes(account.role_name)) {
    return NextResponse.json(
      { error: "Role has changed", code: "MFA_TOKEN_INVALID" },
      { status: 401 },
    );
  }

  // 4d: IP CIDR check
  if (!isIpAllowed(ip, account.allowed_ips ?? [])) {
    return NextResponse.json(
      { error: "Access denied from this network", code: "IP_RESTRICTED" },
      { status: 403 },
    );
  }

  // 4e: Max sessions check
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

  return { accountId, jti, roles, tokenVersion, account, ip };
}
