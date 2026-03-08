import "server-only";

import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { getAccountCustomerIds } from "@/lib/auth/customer-scope";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { hasPermission } from "@/lib/auth/permissions";
import { query } from "@/lib/db/client";

// ── Helpers ─────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Route Handler ───────────────────────────────────────────────

/**
 * DELETE /api/accounts/[id]/customers/[customerId]
 *
 * Remove a customer assignment from an account.
 *
 * Access scope rules:
 * - System Administrator: can remove any assignment.
 * - Tenant Administrator: can only remove assignments for customers
 *   within their own set.
 *
 * Requires `accounts:write` permission.
 */
export const DELETE = withAuth(
  async (request, context, session) => {
    const { id: accountId, customerId: customerIdParam } = await context.params;

    if (!UUID_RE.test(accountId)) {
      return NextResponse.json(
        { error: "Invalid account ID" },
        { status: 400 },
      );
    }

    const customerId = Number(customerIdParam);
    if (!Number.isFinite(customerId) || customerId <= 0) {
      return NextResponse.json(
        { error: "Invalid customer ID" },
        { status: 400 },
      );
    }

    // Verify assignment exists
    const { rows } = await query<{
      account_id: string;
      customer_id: number;
    }>(
      "SELECT account_id, customer_id FROM account_customer WHERE account_id = $1 AND customer_id = $2",
      [accountId, customerId],
    );
    if (rows.length === 0) {
      return NextResponse.json(
        { error: "Assignment not found" },
        { status: 404 },
      );
    }

    // Tenant scope: Tenant Admin can only unassign their own customers
    const accessAll = await hasPermission(
      session.roles,
      "customers:access-all",
    );
    if (!accessAll) {
      const callerCustomerIds = await getAccountCustomerIds(session.accountId);
      if (!callerCustomerIds.includes(customerId)) {
        return NextResponse.json(
          { error: "Cannot unassign customers outside your scope" },
          { status: 403 },
        );
      }
    }

    // Remove assignment
    await query(
      "DELETE FROM account_customer WHERE account_id = $1 AND customer_id = $2",
      [accountId, customerId],
    );

    // Audit
    await auditLog.record({
      actor: session.accountId,
      action: "customer.unassign",
      target: "account",
      targetId: accountId,
      ip: extractClientIp(request),
      sid: session.sessionId,
      details: { customerId },
    });

    return NextResponse.json({ success: true });
  },
  { requiredPermissions: ["accounts:write"] },
);
