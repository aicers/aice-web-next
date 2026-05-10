import "server-only";

import { type NextRequest, NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { hasPermission } from "@/lib/auth/permissions";
import { query } from "@/lib/db/client";
import {
  deleteCustomerExclusion,
  listCustomerExclusions,
  type StoredExclusionRow,
} from "@/lib/triage/exclusion/storage";
import { CustomerNotFoundError } from "@/lib/triage/policy/customer-db";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DELETE /api/triage/exclusions/[id]?customer_id=<id>
 *
 * Removes a customer-scoped exclusion. No retroactive corpus changes.
 */
export const DELETE = withAuth(
  async (request, context, session) => {
    const customerId = parseCustomerId(request);
    if (customerId === null) {
      return NextResponse.json(
        { error: "Missing or invalid customer_id" },
        { status: 400 },
      );
    }
    if (
      !(await callerCanAccessCustomer(
        session.accountId,
        session.roles,
        customerId,
      ))
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await context.params;
    if (!UUID_REGEX.test(id)) {
      return NextResponse.json({ error: "Invalid id" }, { status: 400 });
    }

    let existing: StoredExclusionRow | undefined;
    try {
      const rows = await listCustomerExclusions(customerId);
      existing = rows.find((r) => r.id === id);
    } catch (err) {
      if (err instanceof CustomerNotFoundError) {
        return NextResponse.json({ error: err.message }, { status: 404 });
      }
      throw err;
    }
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const ok = await deleteCustomerExclusion(customerId, id);
    if (!ok) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await auditLog.record({
      actor: session.accountId,
      action: "triage_exclusion.customer_remove",
      target: "triage_exclusion",
      targetId: id,
      ip: extractClientIp(request),
      sid: session.sessionId,
      customerId,
      details: {
        id,
        kind: existing.kind,
        value: existing.value,
      },
    });

    return NextResponse.json({ data: { id } });
  },
  { requiredPermissions: ["triage:exclusion:write"] },
);

function parseCustomerId(request: NextRequest): number | null {
  const raw = request.nextUrl.searchParams.get("customer_id");
  if (raw === null) return null;
  const id = Number(raw);
  if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) return null;
  return id;
}

async function callerCanAccessCustomer(
  accountId: string,
  roles: string[],
  customerId: number,
): Promise<boolean> {
  if (await hasPermission(roles, "customers:access-all")) return true;
  const { rows } = await query<{ customer_id: number }>(
    "SELECT customer_id FROM account_customer WHERE account_id = $1 AND customer_id = $2",
    [accountId, customerId],
  );
  return rows.length > 0;
}
