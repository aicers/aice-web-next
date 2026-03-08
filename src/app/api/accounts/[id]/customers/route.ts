import "server-only";

import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { getAccountCustomerIds } from "@/lib/auth/customer-scope";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { hasPermission } from "@/lib/auth/permissions";
import { query, withTransaction } from "@/lib/db/client";

// ── Helpers ─────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Route Handlers ──────────────────────────────────────────────

/**
 * GET /api/accounts/[id]/customers
 *
 * List customer assignments for an account.
 *
 * Tenant Administrator can only view accounts that share at least one
 * customer with them.  System Administrator is unrestricted.
 *
 * Requires `accounts:read` permission.
 */
export const GET = withAuth(
  async (_request, context, session) => {
    const { id: accountId } = await context.params;
    if (!UUID_RE.test(accountId)) {
      return NextResponse.json(
        { error: "Invalid account ID" },
        { status: 400 },
      );
    }

    // Verify account exists
    const { rows: accountRows } = await query<{ id: string }>(
      "SELECT id FROM accounts WHERE id = $1",
      [accountId],
    );
    if (accountRows.length === 0) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    // Tenant scope check
    const accessAll = await hasPermission(
      session.roles,
      "customers:access-all",
    );
    if (!accessAll) {
      const callerCustomerIds = await getAccountCustomerIds(session.accountId);
      const targetCustomerIds = await getAccountCustomerIds(accountId);
      const overlap = targetCustomerIds.some((id) =>
        callerCustomerIds.includes(id),
      );
      if (!overlap) {
        return NextResponse.json(
          { error: "Account not found" },
          { status: 404 },
        );
      }
    }

    // Fetch assignments
    const { rows } = await query<{
      customer_id: number;
      customer_name: string;
    }>(
      `SELECT ac.customer_id, c.name AS customer_name
       FROM account_customer ac
       JOIN customers c ON c.id = ac.customer_id
       WHERE ac.account_id = $1
       ORDER BY ac.customer_id`,
      [accountId],
    );

    return NextResponse.json({ data: rows });
  },
  { requiredPermissions: ["accounts:read"] },
);

/**
 * POST /api/accounts/[id]/customers
 *
 * Assign one or more customers to an account.
 *
 * Body: `{ customerIds: number[] }`
 *
 * Access scope rules:
 * - System Administrator: can assign any customer.
 * - Tenant Administrator: can only assign customers within their own set.
 *
 * Security Monitor accounts are restricted to a single customer.
 *
 * Requires `accounts:write` permission.
 */
export const POST = withAuth(
  async (request, context, session) => {
    const { id: accountId } = await context.params;
    if (!UUID_RE.test(accountId)) {
      return NextResponse.json(
        { error: "Invalid account ID" },
        { status: 400 },
      );
    }

    // Parse body
    let customerIds: number[];
    try {
      const body = await request.json();
      customerIds = body.customerIds;
      if (
        !Array.isArray(customerIds) ||
        customerIds.length === 0 ||
        !customerIds.every(
          (id) => typeof id === "number" && Number.isInteger(id) && id > 0,
        )
      ) {
        return NextResponse.json(
          {
            error: "customerIds must be a non-empty array of positive integers",
          },
          { status: 400 },
        );
      }
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // Deduplicate
    const uniqueIds = [...new Set(customerIds)];

    // Verify account exists and get its role
    const { rows: accountRows } = await query<{
      id: string;
      role_name: string;
    }>(
      `SELECT a.id, r.name AS role_name
       FROM accounts a JOIN roles r ON a.role_id = r.id
       WHERE a.id = $1`,
      [accountId],
    );
    if (accountRows.length === 0) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    // Verify all customer IDs exist
    const { rows: existingCustomers } = await query<{ id: number }>(
      `SELECT id FROM customers WHERE id = ANY($1)`,
      [uniqueIds],
    );
    if (existingCustomers.length !== uniqueIds.length) {
      const found = new Set(existingCustomers.map((r) => r.id));
      const missing = uniqueIds.filter((id) => !found.has(id));
      return NextResponse.json(
        { error: `Customers not found: ${missing.join(", ")}` },
        { status: 400 },
      );
    }

    // Tenant scope: Tenant Admin can only assign their own customers
    const accessAll = await hasPermission(
      session.roles,
      "customers:access-all",
    );
    if (!accessAll) {
      const callerCustomerIds = await getAccountCustomerIds(session.accountId);
      const callerSet = new Set(callerCustomerIds);
      const outOfScope = uniqueIds.filter((id) => !callerSet.has(id));
      if (outOfScope.length > 0) {
        return NextResponse.json(
          { error: "Cannot assign customers outside your scope" },
          { status: 403 },
        );
      }
    }

    // Security Monitor: restricted to a single customer
    const targetRole = accountRows[0].role_name;
    const assigned = await withTransaction(async (client) => {
      if (targetRole === "Security Monitor") {
        const { rows: countRows } = await client.query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM account_customer WHERE account_id = $1",
          [accountId],
        );
        const existingCount = Number.parseInt(countRows[0].count, 10);

        // Count how many of the requested IDs are genuinely new
        const { rows: alreadyRows } = await client.query<{
          customer_id: number;
        }>(
          "SELECT customer_id FROM account_customer WHERE account_id = $1 AND customer_id = ANY($2)",
          [accountId, uniqueIds],
        );
        const alreadySet = new Set(alreadyRows.map((r) => r.customer_id));
        const newIds = uniqueIds.filter((id) => !alreadySet.has(id));

        if (existingCount + newIds.length > 1) {
          return null; // signal constraint violation
        }
      }

      // Insert assignments
      const insertValues = uniqueIds
        .map((_, i) => `($1, $${i + 2})`)
        .join(", ");
      const insertParams: (string | number)[] = [accountId, ...uniqueIds];
      await client.query(
        `INSERT INTO account_customer (account_id, customer_id)
         VALUES ${insertValues}
         ON CONFLICT DO NOTHING`,
        insertParams,
      );

      return uniqueIds;
    });

    if (assigned === null) {
      return NextResponse.json(
        {
          error:
            "Security Monitor accounts can only be assigned to a single customer",
        },
        { status: 400 },
      );
    }

    // Audit
    await auditLog.record({
      actor: session.accountId,
      action: "customer.assign",
      target: "account",
      targetId: accountId,
      ip: extractClientIp(request),
      sid: session.sessionId,
      details: { customerIds: assigned },
    });

    return NextResponse.json({ success: true, assigned }, { status: 201 });
  },
  { requiredPermissions: ["accounts:write"] },
);
