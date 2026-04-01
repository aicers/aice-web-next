import "server-only";

import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { loadJwtPolicy } from "@/lib/auth/jwt-policy";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { validatePassword } from "@/lib/auth/password-validator";
import { reissueAuthCookies } from "@/lib/auth/rotation";
import { query, withTransaction } from "@/lib/db/client";
import { checkSensitiveOpRateLimit } from "@/lib/rate-limit/limiter";

// ── Types ────────────────────────────────────────────────────────

interface AccountRow {
  password_hash: string;
}

// ── Route Handler ────────────────────────────────────────────────

/**
 * POST /api/auth/password
 *
 * Self-service password change. Requires current password verification.
 * Accessible even when `mustChangePassword=true` (via skipPasswordCheck).
 */
export const POST = withAuth(
  async (request, _context, session) => {
    // Step 1: Parse body
    let currentPassword: string;
    let newPassword: string;
    try {
      const body = await request.json();
      currentPassword = body.currentPassword;
      newPassword = body.newPassword;
      if (!currentPassword || !newPassword) {
        return NextResponse.json(
          { error: "Missing required fields" },
          { status: 400 },
        );
      }
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // Step 2: Sensitive-op rate limit
    const rateLimitResult = await checkSensitiveOpRateLimit(session.accountId);
    if (rateLimitResult.limited) {
      return NextResponse.json(
        { error: "Too many attempts" },
        {
          status: 429,
          headers: {
            "Retry-After": String(rateLimitResult.retryAfterSeconds),
          },
        },
      );
    }

    // Step 3: Fetch current password hash
    const { rows } = await query<AccountRow>(
      "SELECT password_hash FROM accounts WHERE id = $1",
      [session.accountId],
    );
    if (rows.length === 0) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    // Step 4: Verify current password
    const isValid = await verifyPassword(
      rows[0].password_hash,
      currentPassword,
    );
    if (!isValid) {
      return NextResponse.json(
        { error: "Incorrect password", code: "INCORRECT_PASSWORD" },
        { status: 401 },
      );
    }

    // Step 5: Validate new password against policy
    const validation = await validatePassword(newPassword, session.accountId);
    if (!validation.valid) {
      return NextResponse.json(
        { error: "Password policy violation", codes: validation.errors },
        { status: 400 },
      );
    }

    // Fail before mutating state if auth cookies cannot be re-issued.
    if (!process.env.CSRF_SECRET) {
      return NextResponse.json(
        { error: "Server configuration error" },
        { status: 500 },
      );
    }

    // Step 6: Transaction — update password, history, revoke other sessions
    const newHash = await hashPassword(newPassword);
    let nextTokenVersion: number | null = null;
    await withTransaction(async (client) => {
      // Update password hash + clear must_change_password + bump token_version
      const { rows: updatedRows } = await client.query<{
        token_version: number;
      }>(
        `UPDATE accounts
           SET password_hash = $2,
               must_change_password = false,
             password_changed_at = NOW(),
             token_version = token_version + 1
         WHERE id = $1
         RETURNING token_version`,
        [session.accountId, newHash],
      );
      nextTokenVersion = updatedRows[0]?.token_version ?? null;

      // Insert into password_history
      await client.query(
        `INSERT INTO password_history (account_id, password_hash)
         VALUES ($1, $2)`,
        [session.accountId, newHash],
      );

      // Revoke all sessions except the current one
      await client.query(
        `UPDATE sessions SET revoked = true
         WHERE account_id = $1 AND sid != $2 AND revoked = false`,
        [session.accountId, session.sessionId],
      );
    });
    if (nextTokenVersion === null) {
      return NextResponse.json(
        { error: "Password change failed" },
        { status: 500 },
      );
    }

    // Step 7: Audit log
    await auditLog.record({
      actor: session.accountId,
      action: "password.change",
      target: "account",
      targetId: session.accountId,
      ip: extractClientIp(request),
      sid: session.sessionId,
    });

    // Step 8: Re-issue the current auth state with the new token_version
    const reissued = await reissueAuthCookies({
      accountId: session.accountId,
      sessionId: session.sessionId,
      roles: session.roles,
      tokenVersion: nextTokenVersion,
    });
    if (!reissued) {
      return NextResponse.json(
        { error: "Server configuration error" },
        { status: 500 },
      );
    }

    // Keep the in-request session aligned so any post-handler rotation
    // uses the new token_version instead of the stale JWT state.
    const jwtPolicy = await loadJwtPolicy();
    const now = Math.floor(Date.now() / 1000);
    session.tokenVersion = nextTokenVersion;
    session.mustChangePassword = false;
    session.iat = now;
    session.exp = now + jwtPolicy.accessTokenExpirationMinutes * 60;

    // Step 9: Success
    return NextResponse.json({ success: true });
  },
  { skipPasswordCheck: true, skipMfaEnrollCheck: true },
);
