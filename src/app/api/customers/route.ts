import "server-only";

import { randomBytes } from "node:crypto";

import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { hasPermission } from "@/lib/auth/permissions";
import { query } from "@/lib/db/client";
import { provisionCustomerDb } from "@/lib/db/migrate";

// ── Helpers ─────────────────────────────────────────────────────

interface CustomerRow {
  id: number;
  name: string;
  description: string | null;
  database_name: string;
  status: string;
  created_at: string;
  updated_at: string;
}

/**
 * Generate a database-safe name from a customer name.
 *
 * Lowercases, replaces non-alphanumeric runs with `_`, trims to 40 chars,
 * and appends a 6-char random hex suffix for uniqueness.
 */
function generateDatabaseName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);
  const suffix = randomBytes(3).toString("hex");
  return `customer_${slug || "db"}_${suffix}`;
}

// ── Route Handlers ──────────────────────────────────────────────

/**
 * GET /api/customers
 *
 * List all customers. If the caller lacks `customers:access-all`,
 * results are scoped to customers linked via `account_customer`.
 *
 * Requires `customers:read` permission.
 */
export const GET = withAuth(
  async (_request, _context, session) => {
    const accessAll = await hasPermission(
      session.roles,
      "customers:access-all",
    );

    let rows: CustomerRow[];
    if (accessAll) {
      const result = await query<CustomerRow>(
        "SELECT * FROM customers ORDER BY id",
      );
      rows = result.rows;
    } else {
      const result = await query<CustomerRow>(
        `SELECT c.* FROM customers c
         JOIN account_customer ac ON ac.customer_id = c.id
         WHERE ac.account_id = $1
         ORDER BY c.id`,
        [session.accountId],
      );
      rows = result.rows;
    }

    return NextResponse.json({ data: rows });
  },
  { requiredPermissions: ["customers:read"] },
);

/**
 * POST /api/customers
 *
 * Create a new customer and provision its database.
 *
 * Body: `{ name: string, description?: string }`
 *
 * Flow:
 *  1. Insert row with `status = 'provisioning'`
 *  2. Provision the customer database (CREATE DATABASE + migrations)
 *  3. Update status to `'active'`
 *
 * On failure the row and database are cleaned up.
 *
 * Requires `customers:write` permission.
 */
export const POST = withAuth(
  async (request, _context, session) => {
    // Step 1: Parse body
    let name: string;
    let description: string | undefined;
    try {
      const body = await request.json();
      name = body.name;
      description = body.description;
      if (!name || typeof name !== "string" || !name.trim()) {
        return NextResponse.json(
          { error: "Missing required field: name" },
          { status: 400 },
        );
      }
      name = name.trim();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // Step 2: Insert as provisioning
    const databaseName = generateDatabaseName(name);
    const { rows } = await query<CustomerRow>(
      `INSERT INTO customers (name, description, database_name, status)
       VALUES ($1, $2, $3, 'provisioning')
       RETURNING *`,
      [name, description?.trim() || null, databaseName],
    );
    const customer = rows[0];

    // Step 3: Provision the database
    try {
      await provisionCustomerDb(databaseName);
    } catch (err) {
      // Clean up the row on provision failure
      await query("DELETE FROM customers WHERE id = $1", [customer.id]);
      throw err;
    }

    // Step 4: Activate
    const { rows: activeRows } = await query<CustomerRow>(
      `UPDATE customers
       SET status = 'active', updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [customer.id],
    );

    // Step 5: Audit
    await auditLog.record({
      actor: session.accountId,
      action: "customer.create",
      target: "customer",
      targetId: String(customer.id),
      ip: extractClientIp(request),
      sid: session.sessionId,
      details: { name, databaseName },
    });

    return NextResponse.json({ data: activeRows[0] }, { status: 201 });
  },
  { requiredPermissions: ["customers:write"] },
);
