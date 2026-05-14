import "server-only";

import { type NextRequest, NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import {
  applyRecover,
  emitRecoverAudit,
  type RecoverRequest,
} from "@/lib/triage/exclusion/recovery";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/triage/exclusions/global/[id]/recover
 *
 * Session-authenticated global-exclusion recovery (#461 / 1B-7). Two
 * sub-modes via query string:
 *
 *   - default (`?customer_id=<id>`): reset one specific failed
 *     `(global_exclusion_id, customer_id)` fanout row.
 *   - `?all_failed=1`: reset every failed fanout row for this global
 *     exclusion. Used after a tenant-DB outage that exhausted retries
 *     across many customers.
 *
 * Gated on `triage:exclusion:global:write`. The audit row uses the
 * customer-agnostic `triage_exclusion.global_recover` action so the
 * audit-log viewer surfaces it once per operator action rather than
 * once per fanout row reset.
 */
export const POST = withAuth(
  async (request, context, session) => {
    const { id } = await context.params;
    if (!UUID_REGEX.test(id)) {
      return NextResponse.json({ error: "Invalid id" }, { status: 400 });
    }

    const recoverRequest = parseGlobalRecoverRequest(request, id);
    if ("error" in recoverRequest) {
      return NextResponse.json(
        { error: recoverRequest.error },
        { status: 400 },
      );
    }

    const outcome = await applyRecover(recoverRequest);
    if (outcome.reset === 0) {
      return NextResponse.json(
        { error: "No failed fanout rows found for this exclusion" },
        { status: 404 },
      );
    }
    await emitRecoverAudit(recoverRequest, session.accountId, outcome.reset, {
      ip: extractClientIp(request),
      sid: session.sessionId,
    });
    return NextResponse.json({ data: { id, reset: outcome.reset } });
  },
  { requiredPermissions: ["triage:exclusion:global:write"] },
);

function parseGlobalRecoverRequest(
  request: NextRequest,
  exclusionId: string,
): RecoverRequest | { error: string } {
  const allFailed = request.nextUrl.searchParams.get("all_failed");
  if (allFailed === "1" || allFailed === "true") {
    return { kind: "global_all_failed", exclusionId };
  }
  const rawCustomerId = request.nextUrl.searchParams.get("customer_id");
  if (rawCustomerId === null) {
    return {
      error:
        "Either `customer_id=<int>` or `all_failed=1` is required for global recover",
    };
  }
  const customerId = Number(rawCustomerId);
  if (
    !Number.isFinite(customerId) ||
    !Number.isInteger(customerId) ||
    customerId <= 0
  ) {
    return { error: "Invalid customer_id" };
  }
  return { kind: "global", exclusionId, customerId };
}
