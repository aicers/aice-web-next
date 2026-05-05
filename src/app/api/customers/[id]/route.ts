import "server-only";

import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { hasPermission } from "@/lib/auth/permissions";
import {
  ExternalKeyValidationError,
  isExternalKeyUniqueViolation,
  normalizeExternalKey,
} from "@/lib/customers/external-key";
import { query } from "@/lib/db/client";
import { dropCustomerDb } from "@/lib/db/migrate";

// ── Types ───────────────────────────────────────────────────────

interface CustomerRow {
  id: number;
  name: string;
  description: string | null;
  external_key: string | null;
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
 * Update a customer's name, description, and/or external_key.
 *
 * Body: `{ name?: string, description?: string, external_key?: string | null }`
 *
 * `external_key` semantics (#438):
 *   - omitted from body → no change
 *   - explicit `null` / empty / whitespace-only → cleared to NULL
 *   - non-empty string → trimmed, validated (≤256 chars, no control chars)
 *
 * UNIQUE conflicts on `external_key` produce a 409.
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
    // `undefined` means "field omitted, do not change".
    let externalKey: string | null | undefined;
    try {
      const body = await request.json();
      name = body.name;
      description = body.description;
      externalKey = normalizeExternalKey(body.external_key);
    } catch (err) {
      if (err instanceof ExternalKeyValidationError) {
        return NextResponse.json(
          { error: err.message, field: "external_key" },
          { status: 400 },
        );
      }
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

    const previousRow = existing[0];
    const trimmedName = name?.trim();
    const trimmedDescription =
      description === undefined ? undefined : description?.trim() || null;

    const changedFields: string[] = [];
    const previous: Record<string, unknown> = {};
    const next: Record<string, unknown> = {};

    if (trimmedName !== undefined && trimmedName !== previousRow.name) {
      updates.push(`name = $${idx++}`);
      params.push(trimmedName);
      changedFields.push("name");
      previous.name = previousRow.name;
      next.name = trimmedName;
    }
    if (
      trimmedDescription !== undefined &&
      trimmedDescription !== previousRow.description
    ) {
      updates.push(`description = $${idx++}`);
      params.push(trimmedDescription);
      changedFields.push("description");
      previous.description = previousRow.description;
      next.description = trimmedDescription;
    }
    // external_key: only include in the SET / changedFields when the
    // effective value actually changes (covers NULL→NULL no-op, e.g.
    // an empty input on a row that's already NULL).
    if (externalKey !== undefined && externalKey !== previousRow.external_key) {
      updates.push(`external_key = $${idx++}`);
      params.push(externalKey);
      changedFields.push("external_key");
      previous.external_key = previousRow.external_key;
      next.external_key = externalKey;
    }

    if (updates.length === 0) {
      return NextResponse.json({ data: previousRow });
    }

    updates.push(`updated_at = NOW()`);
    params.push(customerId);

    let updatedRow: CustomerRow;
    try {
      const { rows } = await query<CustomerRow>(
        `UPDATE customers SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`,
        params,
      );
      updatedRow = rows[0];
    } catch (err) {
      if (isExternalKeyUniqueViolation(err)) {
        return NextResponse.json(
          {
            error: "external_key is already in use by another customer",
            field: "external_key",
            code: "external_key_conflict",
          },
          { status: 409 },
        );
      }
      throw err;
    }

    // Audit (aligns with aimer-web #196 `changedFields` detail shape;
    // we keep the existing `customer.update` action — see #438).
    await auditLog.record({
      actor: session.accountId,
      action: "customer.update",
      target: "customer",
      targetId: String(customerId),
      ip: extractClientIp(request),
      sid: session.sessionId,
      // Top-level `customerId` populated so the audit-log viewer (#386)
      // surfaces the row to the tenant operator who owns this customer.
      customerId,
      details: {
        changedFields,
        previous,
        next,
        customerId,
        customerName: updatedRow.name,
      },
    });

    return NextResponse.json({ data: updatedRow });
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

    // Tenant scope check — mirrors GET / PATCH on the same resource. A
    // non-`access-all` caller with `customers:delete` must not be able
    // to drop a customer outside their scope.
    const accessAll = await hasPermission(
      session.roles,
      "customers:access-all",
    );
    if (!accessAll) {
      const { rows: scopeRows } = await query<{ customer_id: number }>(
        "SELECT customer_id FROM account_customer WHERE account_id = $1 AND customer_id = $2",
        [session.accountId, customerId],
      );
      if (scopeRows.length === 0) {
        return NextResponse.json(
          { error: "Customer not found" },
          { status: 404 },
        );
      }
    }

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
      // Top-level `customerId` populated so the audit-log viewer (#386)
      // surfaces this delete to the tenant operator who owned the
      // customer (now removed). Without it the row is invisible under a
      // `customer_id IN (...)` predicate.
      customerId,
      details: { name: customer.name, databaseName: customer.database_name },
    });

    return NextResponse.json({ success: true });
  },
  { requiredPermissions: ["customers:delete"] },
);
