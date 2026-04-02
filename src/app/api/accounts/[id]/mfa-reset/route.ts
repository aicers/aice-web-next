import "server-only";

import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { validateManagedAccountTarget } from "@/lib/auth/account-management";
import { rolePermissionsSelectSql } from "@/lib/auth/account-role-policy";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { clearAllMfaCredentials } from "@/lib/auth/mfa-credentials";
import { isUserMfaEnrolled } from "@/lib/auth/mfa-enforcement";
import { verifyPassword } from "@/lib/auth/password";
import { query, withTransaction } from "@/lib/db/client";
import { checkSensitiveOpRateLimit } from "@/lib/rate-limit/limiter";

// ── Route Handler ────────────────────────────────────────────────

/**
 * POST /api/accounts/[id]/mfa-reset
 *
 * Admin-initiated MFA reset. Removes all TOTP credentials, WebAuthn
 * credentials, and recovery codes for the target account. Requires
 * step-up authentication (admin's own password).
 *
 * Requires `accounts:write` permission.
 */
export const POST = withAuth(
  async (request, context, session) => {
    const { id: accountId } = await context.params;

    // Step 1: Parse body
    let password: string;
    try {
      const body = await request.json();
      password = body.password;
      if (!password) {
        return NextResponse.json(
          { error: "Missing required field: password" },
          { status: 400 },
        );
      }
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // Step 2: Block self-reset
    if (accountId === session.accountId) {
      return NextResponse.json(
        { error: "Cannot reset own MFA" },
        { status: 400 },
      );
    }

    // Step 3: Fetch target account with role info
    const { rows: accountRows } = await query<{
      id: string;
      username: string;
      role_id: number;
      role_name: string;
      role_permissions: string[];
    }>(
      `SELECT a.id, a.username, a.role_id, r.name AS role_name,
              ${rolePermissionsSelectSql("r", "role_permissions")}
       FROM accounts a
       JOIN roles r ON a.role_id = r.id
       WHERE a.id = $1`,
      [accountId],
    );
    if (accountRows.length === 0) {
      return NextResponse.json(
        { error: "Account not found", code: "ACCOUNT_NOT_FOUND" },
        { status: 404 },
      );
    }

    // Step 4: Tenant scoping
    const accessError = await validateManagedAccountTarget(
      session,
      accountRows[0],
    );
    if (accessError) {
      return NextResponse.json(
        { error: accessError.error },
        { status: accessError.status },
      );
    }

    // Step 5: Role hierarchy — cannot reset MFA for equal or higher roles
    const targetPermissions = accountRows[0].role_permissions;
    if (targetPermissions.includes("customers:access-all")) {
      return NextResponse.json(
        {
          error: "Cannot reset MFA for accounts with equal or higher role",
          code: "ROLE_HIERARCHY",
        },
        { status: 403 },
      );
    }

    // Step 6a: Verify target actually has MFA enrolled
    const hasMfa = await isUserMfaEnrolled(accountId);
    if (!hasMfa) {
      return NextResponse.json(
        { error: "Account has no MFA enrolled", code: "NO_MFA" },
        { status: 409 },
      );
    }

    // Step 6b: Rate limit on step-up authentication
    const rateLimitResult = await checkSensitiveOpRateLimit(session.accountId);
    if (rateLimitResult.limited) {
      return NextResponse.json(
        { error: "Too many attempts" },
        {
          status: 429,
          headers: { "Retry-After": String(rateLimitResult.retryAfterSeconds) },
        },
      );
    }

    // Step 6c: Step-up authentication — verify admin's own password
    const { rows: callerRows } = await query<{ password_hash: string }>(
      "SELECT password_hash FROM accounts WHERE id = $1",
      [session.accountId],
    );
    if (
      callerRows.length === 0 ||
      !(await verifyPassword(callerRows[0].password_hash, password))
    ) {
      return NextResponse.json(
        { error: "Invalid password", code: "INVALID_PASSWORD" },
        { status: 401 },
      );
    }

    // Step 7: Delete all MFA credentials and revoke sessions
    await withTransaction(async (client) => {
      await clearAllMfaCredentials(client, accountId);
    });

    // Step 8: Audit log
    await auditLog.record({
      actor: session.accountId,
      action: "mfa.admin.reset",
      target: "account",
      targetId: accountId,
      ip: extractClientIp(request),
      sid: session.sessionId,
      details: { targetUsername: accountRows[0].username },
    });

    // Step 9: Success
    return NextResponse.json({ success: true });
  },
  { requiredPermissions: ["accounts:write"] },
);
