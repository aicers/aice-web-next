import "server-only";

import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";

import {
  generateCorrelationId,
  withCorrelationId,
} from "@/lib/audit/correlation";
import { auditLog } from "@/lib/audit/logger";
import { isIpAllowed } from "@/lib/auth/cidr";
import { TOKEN_EXPIRATION_SECONDS } from "@/lib/auth/constants";
import { setAccessTokenCookie, setTokenExpCookie } from "@/lib/auth/cookies";
import {
  CSRF_COOKIE_NAME,
  CSRF_COOKIE_OPTIONS,
  generateCsrfToken,
} from "@/lib/auth/csrf";
import { extractClientIp } from "@/lib/auth/ip";
import { issueAccessToken } from "@/lib/auth/jwt";
import { verifyPassword } from "@/lib/auth/password";
import { loadSessionPolicy } from "@/lib/auth/session-policy";
import { extractBrowserFingerprint } from "@/lib/auth/ua-parser";
import { query } from "@/lib/db/client";
import { checkSignInRateLimit } from "@/lib/rate-limit/limiter";

// ── Lockout defaults (matching migration 0007) ─────────────────

interface LockoutPolicy {
  stage1Threshold: number;
  stage1DurationMinutes: number;
  stage2Threshold: number;
}

const DEFAULT_LOCKOUT: LockoutPolicy = {
  stage1Threshold: 5,
  stage1DurationMinutes: 30,
  stage2Threshold: 3,
};

interface LockoutPolicyRow {
  stage1_threshold: number;
  stage1_duration_minutes: number;
  stage2_threshold: number;
}

// ── Account row type ────────────────────────────────────────────

interface AccountRow {
  id: string;
  password_hash: string;
  status: string;
  token_version: number;
  must_change_password: boolean;
  failed_sign_in_count: number;
  locked_until: string | null;
  max_sessions: number | null;
  allowed_ips: string[] | null;
  role_name: string;
}

// ── Helpers ─────────────────────────────────────────────────────

async function loadLockoutPolicy(): Promise<LockoutPolicy> {
  try {
    const result = await query<{ value: LockoutPolicyRow }>(
      "SELECT value FROM system_settings WHERE key = $1",
      ["lockout_policy"],
    );
    if (result.rows.length > 0) {
      const db = result.rows[0].value;
      return {
        stage1Threshold: db.stage1_threshold ?? DEFAULT_LOCKOUT.stage1Threshold,
        stage1DurationMinutes:
          db.stage1_duration_minutes ?? DEFAULT_LOCKOUT.stage1DurationMinutes,
        stage2Threshold: db.stage2_threshold ?? DEFAULT_LOCKOUT.stage2Threshold,
      };
    }
  } catch {
    // DB unavailable — use defaults
  }
  return { ...DEFAULT_LOCKOUT };
}

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

  if (newFailCount >= lockout.stage1Threshold + lockout.stage2Threshold) {
    // Stage 2 — permanent lock
    await query(
      `UPDATE accounts
       SET failed_sign_in_count = $1, status = 'locked', locked_until = NULL
       WHERE id = $2`,
      [newFailCount, account.id],
    );
    await auditLog.record({
      actor: account.id,
      action: "account.lock",
      target: "account",
      targetId: account.id,
      details: { reason: "stage2_permanent", failedCount: newFailCount, ip },
    });
  } else if (newFailCount >= lockout.stage1Threshold) {
    // Stage 1 — temporary lock
    await query(
      `UPDATE accounts
       SET failed_sign_in_count = $1, status = 'locked',
           locked_until = NOW() + $2 * INTERVAL '1 minute'
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

/**
 * Create a new session, issue JWT + CSRF tokens, set cookies,
 * and log a successful sign-in.
 */
async function createSessionAndIssueTokens(params: {
  accountId: string;
  roleName: string;
  tokenVersion: number;
  mustChangePassword: boolean;
  ip: string;
  userAgent: string;
}): Promise<NextResponse> {
  const {
    accountId,
    roleName,
    tokenVersion,
    mustChangePassword,
    ip,
    userAgent,
  } = params;

  // Reset failed count and update last_sign_in_at
  await query(
    `UPDATE accounts
     SET failed_sign_in_count = 0, last_sign_in_at = NOW()
     WHERE id = $1`,
    [accountId],
  );

  // Create session
  const browserFingerprint = extractBrowserFingerprint(userAgent);
  const { rows: sessionRows } = await query<{ sid: string }>(
    `INSERT INTO sessions (sid, account_id, ip_address, user_agent, browser_fingerprint)
     VALUES (gen_random_uuid(), $1, $2, $3, $4)
     RETURNING sid`,
    [accountId, ip, userAgent, browserFingerprint],
  );
  const sessionId = sessionRows[0].sid;

  // Issue JWT
  const jwt = await issueAccessToken({
    accountId,
    sessionId,
    roles: [roleName],
    tokenVersion,
  });

  // Issue CSRF token
  const csrfSecret = process.env.CSRF_SECRET;
  if (!csrfSecret) {
    return NextResponse.json(
      { error: "Server configuration error" },
      { status: 500 },
    );
  }
  const { token: csrfToken } = generateCsrfToken(sessionId, csrfSecret);

  // Set cookies
  const tokenExp = Math.floor(Date.now() / 1000) + TOKEN_EXPIRATION_SECONDS;
  await setAccessTokenCookie(jwt, TOKEN_EXPIRATION_SECONDS);
  await setTokenExpCookie(tokenExp, TOKEN_EXPIRATION_SECONDS);
  const cookieStore = await cookies();
  cookieStore.set(CSRF_COOKIE_NAME, csrfToken, {
    ...CSRF_COOKIE_OPTIONS,
    maxAge: TOKEN_EXPIRATION_SECONDS,
  });

  // Audit success
  await auditLog.record({
    actor: accountId,
    action: "auth.sign_in.success",
    target: "session",
    targetId: sessionId,
    ip,
    sid: sessionId,
  });

  return NextResponse.json({ mustChangePassword });
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
            a.must_change_password, a.failed_sign_in_count,
            a.locked_until, a.max_sessions, a.allowed_ips,
            r.name AS role_name
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
    ip,
    userAgent,
  });
}

// ── Route export ────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  const correlationId = generateCorrelationId();
  return withCorrelationId(correlationId, () => handleSignIn(request));
}
