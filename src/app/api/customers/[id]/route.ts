import "server-only";

import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { hasPermission } from "@/lib/auth/permissions";
import { query } from "@/lib/db/client";
import { dropCustomerDb } from "@/lib/db/migrate";

// ── Types ───────────────────────────────────────────────────────

interface CustomerRow {
  id: number;
  name: string;
  description: string | null;
  database_name: string;
  status: string;
  created_at: string;
  updated_at: string;
}

// ── Route Handlers ──────────────────────────────────────────────

/**
 * GET /api/customers/[id]
 *
 * Fetch a single customer. Tenant-scoped unless the caller holds
 * `customers:access-all`.
 *
 * Requires `customers:read` permission.
 */
export const GET = withAuth(
  async (_request, context, session) => {
    const { id } = await context.params;
    const customerId = Number(id);
    if (!Number.isFinite(customerId)) {
      return NextResponse.json(
        { error: "Invalid customer ID" },
        { status: 400 },
      );
    }

    const { rows } = await query<CustomerRow>(
      "SELECT * FROM customers WHERE id = $1",
      [customerId],
    );
    if (rows.length === 0) {
      return NextResponse.json(
        { error: "Customer not found" },
        { status: 404 },
      );
    }

    // Tenant scope check
    const accessAll = await hasPermission(
      session.roles,
      "customers:access-all",
    );
    if (!accessAll) {
      const { rows: linkRows } = await query<{ customer_id: number }>(
        "SELECT customer_id FROM account_customer WHERE account_id = $1 AND customer_id = $2",
        [session.accountId, customerId],
      );
      if (linkRows.length === 0) {
        return NextResponse.json(
          { error: "Customer not found" },
          { status: 404 },
        );
      }
    }

    return NextResponse.json({ data: rows[0] });
  },
  { requiredPermissions: ["customers:read"] },
);

/**
 * PATCH /api/customers/[id]
 *
 * Update a customer's name and/or description.
 *
 * Body: `{ name?: string, description?: string }`
 *
 * Requires `customers:write` permission.
 */
export const PATCH = withAuth(
  async (request, context, session) => {
    const { id } = await context.params;
    const customerId = Number(id);
    if (!Number.isFinite(customerId)) {
      return NextResponse.json(
        { error: "Invalid customer ID" },
        { status: 400 },
      );
    }

    // Parse body
    let name: string | undefined;
    let description: string | undefined;
    try {
      const body = await request.json();
      name = body.name;
      description = body.description;
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (
      name !== undefined &&
      (!name || typeof name !== "string" || !name.trim())
    ) {
      return NextResponse.json(
        { error: "Name must be a non-empty string" },
        { status: 400 },
      );
    }

    // Check existence
    const { rows: existing } = await query<CustomerRow>(
      "SELECT * FROM customers WHERE id = $1",
      [customerId],
    );
    if (existing.length === 0) {
      return NextResponse.json(
        { error: "Customer not found" },
        { status: 404 },
      );
    }

    // Tenant scope check
    const accessAll = await hasPermission(
      session.roles,
      "customers:access-all",
    );
    if (!accessAll) {
      const { rows: linkRows } = await query<{ customer_id: number }>(
        "SELECT customer_id FROM account_customer WHERE account_id = $1 AND customer_id = $2",
        [session.accountId, customerId],
      );
      if (linkRows.length === 0) {
        return NextResponse.json(
          { error: "Customer not found" },
          { status: 404 },
        );
      }
    }

    // Build update
    const updates: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (name !== undefined) {
      updates.push(`name = $${idx++}`);
      params.push(name.trim());
    }
    if (description !== undefined) {
      updates.push(`description = $${idx++}`);
      params.push(description?.trim() || null);
    }

    if (updates.length === 0) {
      return NextResponse.json({ data: existing[0] });
    }

    updates.push(`updated_at = NOW()`);
    params.push(customerId);

    const { rows } = await query<CustomerRow>(
      `UPDATE customers SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`,
      params,
    );

    // Audit
    await auditLog.record({
      actor: session.accountId,
      action: "customer.update",
      target: "customer",
      targetId: String(customerId),
      ip: extractClientIp(request),
      sid: session.sessionId,
      details: {
        ...(name !== undefined && { name: name.trim() }),
        ...(description !== undefined && {
          description: description?.trim() || null,
        }),
      },
    });

    return NextResponse.json({ data: rows[0] });
  },
  { requiredPermissions: ["customers:write"] },
);

/**
 * DELETE /api/customers/[id]
 *
 * Delete a customer and drop its database.
 *
 * Fails if the customer has linked accounts in `account_customer`.
 *
 * Requires `customers:delete` permission.
 */
export const DELETE = withAuth(
  async (request, context, session) => {
    const { id } = await context.params;
    const customerId = Number(id);
    if (!Number.isFinite(customerId)) {
      return NextResponse.json(
        { error: "Invalid customer ID" },
        { status: 400 },
      );
    }

    // Check existence
    const { rows } = await query<CustomerRow>(
      "SELECT * FROM customers WHERE id = $1",
      [customerId],
    );
    if (rows.length === 0) {
      return NextResponse.json(
        { error: "Customer not found" },
        { status: 404 },
      );
    }

    const customer = rows[0];

    // Check for linked accounts
    const { rows: linkRows } = await query<{ customer_id: number }>(
      "SELECT customer_id FROM account_customer WHERE customer_id = $1 LIMIT 1",
      [customerId],
    );
    if (linkRows.length > 0) {
      return NextResponse.json(
        { error: "Cannot delete customer with active account assignments" },
        { status: 400 },
      );
    }

    // Drop database first, then delete the row
    await dropCustomerDb(customer.database_name);
    await query("DELETE FROM customers WHERE id = $1", [customerId]);

    // Audit
    await auditLog.record({
      actor: session.accountId,
      action: "customer.delete",
      target: "customer",
      targetId: String(customerId),
      ip: extractClientIp(request),
      sid: session.sessionId,
      details: { name: customer.name, databaseName: customer.database_name },
    });

    return NextResponse.json({ success: true });
  },
  { requiredPermissions: ["customers:delete"] },
);
