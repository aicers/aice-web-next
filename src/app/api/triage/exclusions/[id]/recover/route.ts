import "server-only";

import { type NextRequest, NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { hasPermission } from "@/lib/auth/permissions";
import { query } from "@/lib/db/client";
import {
  applyRecover,
  emitRecoverAudit,
  type RecoverRequest,
} from "@/lib/triage/exclusion/recovery";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/triage/exclusions/[id]/recover?customer_id=<id>
 *
 * Session-authenticated customer-scoped recovery (#461 / 1B-7). Resets
 * the customer-scoped drain-failure sentinel for exclusion `[id]` in
 * tenant `customer_id`. Gated on `triage:exclusion:write` plus the
 * caller's effective customer scope, matching the create / delete
 * routes for this resource.
 */
export const POST = withAuth(
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

    const recoverRequest: RecoverRequest = {
      kind: "customer",
      exclusionId: id,
      customerId,
    };
    const outcome = await applyRecover(recoverRequest);
    if (outcome.reset === 0) {
      return NextResponse.json(
        { error: "No failed cleanup found for this exclusion" },
        { status: 404 },
      );
    }
    await emitRecoverAudit(recoverRequest, session.accountId, outcome.reset, {
      ip: extractClientIp(request),
      sid: session.sessionId,
    });
    return NextResponse.json({ data: { id, reset: outcome.reset } });
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
