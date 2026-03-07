import "server-only";

import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { query } from "@/lib/db/client";

// ── Route Handler ────────────────────────────────────────────────

/**
 * POST /api/accounts/[id]/unlock
 *
 * Unlock a locked account or restore a suspended account.
 *
 * - `locked` → `active`: clears lockout timer, resets failed count,
 *   preserves `lockout_count` (Stage 2 may still engage on next lockout).
 * - `suspended` → `active`: full restore, resets both `lockout_count`
 *   and `failed_sign_in_count`.
 *
 * Requires `accounts:write` permission.
 */
export const POST = withAuth(
  async (request, context, session) => {
    const { id: accountId } = await context.params;

    // Step 1: Fetch account status
    const { rows } = await query<{
      id: string;
      status: string;
      lockout_count: number;
    }>("SELECT id, status, lockout_count FROM accounts WHERE id = $1", [
      accountId,
    ]);

    if (rows.length === 0) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    const account = rows[0];
    const ip = extractClientIp(request);

    // Step 2: Dispatch by status
    if (account.status === "locked") {
      await query(
        `UPDATE accounts
         SET status = 'active', locked_until = NULL,
             failed_sign_in_count = 0
         WHERE id = $1`,
        [accountId],
      );

      await auditLog.record({
        actor: session.accountId,
        action: "account.unlock",
        target: "account",
        targetId: accountId,
        ip,
        sid: session.sessionId,
        details: { previousLockoutCount: account.lockout_count },
      });

      return NextResponse.json({ success: true, action: "unlocked" });
    }

    if (account.status === "suspended") {
      await query(
        `UPDATE accounts
         SET status = 'active', locked_until = NULL,
             failed_sign_in_count = 0, lockout_count = 0
         WHERE id = $1`,
        [accountId],
      );

      await auditLog.record({
        actor: session.accountId,
        action: "account.restore",
        target: "account",
        targetId: accountId,
        ip,
        sid: session.sessionId,
        details: { previousLockoutCount: account.lockout_count },
      });

      return NextResponse.json({ success: true, action: "restored" });
    }

    // Account is neither locked nor suspended
    return NextResponse.json(
      { error: "Account is not locked or suspended" },
      { status: 400 },
    );
  },
  { requiredPermissions: ["accounts:write"] },
);
