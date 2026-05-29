import "server-only";

import { NextResponse } from "next/server";

import { isSystemAdministrator } from "@/lib/aimer/role-guard";
import { auditLog } from "@/lib/audit/logger";
import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";

/**
 * `POST /api/aimer/phase2/cadence-drain`
 *
 * Thin audit wrapper for the app-shell cadence manager (#651). The
 * cadence runs its drain in the browser via `drainOpportunisticPushQueue`
 * (same as "Sync now"); the server never drains here. This route only
 * records the `aimer_phase2.cadence_drain` audit row when a cadence tick
 * has actually changed server state.
 *
 * "Changed server state" is the condition `delivered + no_op > 0` — a
 * successful non-empty batch, which includes withdraw no-op acks
 * (`not_found`) that still remove the queue row. The browser only POSTs
 * when that holds, but the route owns the audit policy and enforces it
 * regardless of caller: a request with `delivered + no_op === 0` returns
 * `204` without recording, so a bare `exhausted` / `no_more` no-op tick
 * never reaches the log — keeping a 5-minute cadence from flooding it
 * with ~288 rows/customer/day of noise.
 *
 * The split mirrors `sync-now`: the server owns the audit identity
 * (operator + customer + timestamp) while the byte-moving drain stays in
 * the browser. The `delivered` / `noOp` counts are browser-reported and
 * informational, not server-authoritative.
 *
 * Body: `{ "customer_id": <positive integer>, "kind": "baseline_event" |
 * "story", "delivered": <int ≥0>, "no_op": <int ≥0> }`. Non-integer or
 * negative counts are rejected with `400`.
 * Response: `204 No Content` whether or not a row was recorded (an audit
 * row is written only when `delivered + no_op > 0`).
 * Gated by {@link isSystemAdministrator}.
 */

const CADENCE_KINDS = ["baseline_event", "story"] as const;
type CadenceKind = (typeof CADENCE_KINDS)[number];

interface RequestBody {
  customer_id?: unknown;
  kind?: unknown;
  delivered?: unknown;
  no_op?: unknown;
}

function isCadenceKind(value: unknown): value is CadenceKind {
  return (
    typeof value === "string" &&
    (CADENCE_KINDS as readonly string[]).includes(value)
  );
}

function asNonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
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
  if (!isCadenceKind(body.kind)) {
    return NextResponse.json(
      { error: "kind must be baseline_event or story" },
      { status: 400 },
    );
  }
  const customerId = body.customer_id;
  const delivered = asNonNegativeInt(body.delivered);
  const noOp = asNonNegativeInt(body.no_op);
  if (delivered === null || noOp === null) {
    return NextResponse.json(
      { error: "delivered and no_op must be non-negative integers" },
      { status: 400 },
    );
  }

  const ids = await resolveEffectiveCustomerIds(
    session.accountId,
    session.roles,
  );
  if (!ids.includes(customerId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // State-change-only audit (#651): a tick that acked nothing
  // (`delivered + no_op === 0`) records no row, so a 5-minute cadence
  // cannot flood the log with ~288 no-op entries/customer/day. The browser
  // already skips these posts, but the route owns the audit policy and
  // enforces it regardless of caller.
  if (delivered + noOp <= 0) {
    return new NextResponse(null, { status: 204 });
  }

  await auditLog.record({
    actor: session.accountId,
    action: "aimer_phase2.cadence_drain",
    target: "customer",
    targetId: String(customerId),
    ip: extractClientIp(request),
    sid: session.sessionId,
    customerId,
    details: {
      kind: body.kind,
      delivered,
      noOp,
    },
  });

  return new NextResponse(null, { status: 204 });
});
