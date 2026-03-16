import "server-only";

import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { validateManagedAccountTarget } from "@/lib/auth/account-management";
import { rolePermissionsSelectSql } from "@/lib/auth/account-role-policy";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { hashPassword } from "@/lib/auth/password";
import { validatePassword } from "@/lib/auth/password-validator";
import { query, withTransaction } from "@/lib/db/client";

// ── Route Handler ────────────────────────────────────────────────

/**
 * POST /api/accounts/[id]/password-reset
 *
 * Admin-initiated password reset. Sets a new temporary password and
 * forces the target account to change it on next sign-in.
 *
 * Requires `accounts:write` permission.
 */
export const POST = withAuth(
  async (request, context, session) => {
    const { id: accountId } = await context.params;

    // Step 1: Parse body
    let newPassword: string;
    try {
      const body = await request.json();
      newPassword = body.newPassword;
      if (!newPassword) {
        return NextResponse.json(
          { error: "Missing required field: newPassword" },
          { status: 400 },
        );
      }
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (accountId === session.accountId) {
      return NextResponse.json(
        { error: "Cannot reset own password" },
        { status: 400 },
      );
    }

    // Step 2: Validate account exists
    const { rows: accountRows } = await query<{
      id: string;
      role_id: number;
      role_name: string;
      role_permissions: string[];
    }>(
      `SELECT a.id, a.role_id, r.name AS role_name,
              ${rolePermissionsSelectSql("r", "role_permissions")}
       FROM accounts a
       JOIN roles r ON a.role_id = r.id
       WHERE a.id = $1`,
      [accountId],
    );
    if (accountRows.length === 0) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

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

    // Step 3: Validate new password against policy (skip reuse ban)
    const validation = await validatePassword(newPassword, accountId, true);
    if (!validation.valid) {
      return NextResponse.json(
        { error: "Password policy violation", codes: validation.errors },
        { status: 400 },
      );
    }

    // Step 4: Transaction — update password + force change + revoke sessions
    const newHash = await hashPassword(newPassword);
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE accounts
         SET password_hash = $2,
             must_change_password = true,
             token_version = token_version + 1
         WHERE id = $1`,
        [accountId, newHash],
      );

      await client.query(
        `INSERT INTO password_history (account_id, password_hash)
         VALUES ($1, $2)`,
        [accountId, newHash],
      );

      await client.query(
        `UPDATE sessions SET revoked = true
         WHERE account_id = $1 AND revoked = false`,
        [accountId],
      );
    });

    // Step 5: Audit log
    await auditLog.record({
      actor: session.accountId,
      action: "password.reset",
      target: "account",
      targetId: accountId,
      ip: extractClientIp(request),
      sid: session.sessionId,
    });

    // Step 6: Success
    return NextResponse.json({ success: true });
  },
  { requiredPermissions: ["accounts:write"] },
);
