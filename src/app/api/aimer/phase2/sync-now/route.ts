import "server-only";

import { NextResponse } from "next/server";

import { isSystemAdministrator } from "@/lib/aimer/role-guard";
import { auditLog } from "@/lib/audit/logger";
import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";

/**
 * `POST /api/aimer/phase2/sync-now`
 *
 * Thin wrapper route invoked by the Settings "Sync now" button (#620).
 * The route's only job is to record the `aimer_phase2.sync_now` audit
 * row server-authoritatively for the operator click; after the wrapper
 * acks, the browser triggers `drainOpportunisticPushQueue` for each
 * streaming/queue kind in parallel and reports a local per-kind
 * summary. The drain itself never runs on the server here.
 *
 * The "audit-on-server, drain-in-browser" split preserves the
 * source-of-truth identity (operator + customer + timestamp from the
 * server) without introducing a parallel server-driven drain path.
 *
 * Audit `details.triggeredKinds` is a static list of dispatched kinds,
 * not actual completion counts — those live in client-side state from
 * drain return values (informational, not audit truth).
 *
 * Body: `{ "customer_id": <positive integer> }`.
 * Response: `204 No Content` on success.
 * Gated by {@link isSystemAdministrator}.
 */

const TRIGGERED_KINDS = ["baseline_event", "story", "policy_event"] as const;

interface RequestBody {
  customer_id?: unknown;
}

export const POST = withAuth(async (request, _context, session) => {
  if (!isSystemAdministrator(session.roles)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (
    typeof body.customer_id !== "number" ||
    !Number.isInteger(body.customer_id) ||
    body.customer_id <= 0
  ) {
    return NextResponse.json(
      { error: "customer_id must be a positive integer" },
      { status: 400 },
    );
  }
  const customerId = body.customer_id;

  const ids = await resolveEffectiveCustomerIds(
    session.accountId,
    session.roles,
  );
  if (!ids.includes(customerId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await auditLog.record({
    actor: session.accountId,
    action: "aimer_phase2.sync_now",
    target: "customer",
    targetId: String(customerId),
    ip: extractClientIp(request),
    sid: session.sessionId,
    customerId,
    details: {
      triggeredKinds: TRIGGERED_KINDS,
    },
  });

  return new NextResponse(null, { status: 204 });
});
