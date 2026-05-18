import "server-only";

import { NextResponse } from "next/server";

import {
  Phase2BackfillMultiVersionError,
  runPhase2Backfill,
} from "@/lib/aimer/phase2/backfill";
import { isSystemAdministrator } from "@/lib/aimer/role-guard";
import { auditLog } from "@/lib/audit/logger";
import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { BASELINE_TRIAGED_EVENT_RETENTION_DAYS } from "@/lib/triage/baseline/retention";
import { CustomerNotFoundError } from "@/lib/triage/policy/customer-db";

/**
 * `POST /api/aimer/phase2/backfill`
 *
 * Session-authenticated wrapper around `runPhase2Backfill` (the helper
 * shared with the internal-token route `POST
 * /api/internal/aimer/phase2/backfill`). Used by the Settings UI
 * Backfill form (#620). The internal-token route remains the
 * deployment-side surface for ops runbooks; this wrapper exposes the
 * same operation under the operator's session + audit context.
 *
 * Body: `{ "customer_id": <int>,
 *          "kind": "baseline_event" | "story",
 *          "from": <ISO>, "to": <ISO> }`.
 *
 * Window bounds mirror the internal route:
 *   - `from` must be strictly before `to`.
 *   - `to` must not extend into the future (60s skew slack).
 *   - `from` may not be older than the baseline corpus retention
 *     horizon (`BASELINE_TRIAGED_EVENT_RETENTION_DAYS`).
 *
 * Emits `aimer_phase2.backfill` audit with `customerId`, `kind`,
 * `from`, `to`, `enqueuedNoticeCount`. Gated by
 * {@link isSystemAdministrator}.
 */

const FUTURE_SKEW_MS = 60_000;
const MAX_AGE_MS = BASELINE_TRIAGED_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

interface RequestBody {
  customer_id?: unknown;
  kind?: unknown;
  from?: unknown;
  to?: unknown;
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

  if (body.kind !== "baseline_event" && body.kind !== "story") {
    return NextResponse.json(
      { error: "kind must be 'baseline_event' or 'story'" },
      { status: 400 },
    );
  }
  const kind = body.kind;

  if (typeof body.from !== "string" || typeof body.to !== "string") {
    return NextResponse.json(
      { error: "from and to must be ISO-8601 strings" },
      { status: 400 },
    );
  }
  const fromDate = new Date(body.from);
  const toDate = new Date(body.to);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return NextResponse.json(
      { error: "from and to must be valid ISO-8601 timestamps" },
      { status: 400 },
    );
  }
  if (fromDate.getTime() >= toDate.getTime()) {
    return NextResponse.json(
      { error: "from must be strictly before to" },
      { status: 400 },
    );
  }
  const nowMs = Date.now();
  if (toDate.getTime() > nowMs + FUTURE_SKEW_MS) {
    return NextResponse.json(
      { error: "to must not extend into the future" },
      { status: 400 },
    );
  }
  if (fromDate.getTime() < nowMs - MAX_AGE_MS) {
    return NextResponse.json(
      {
        error: `from must not be older than ${BASELINE_TRIAGED_EVENT_RETENTION_DAYS} days`,
      },
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

  try {
    const result = await runPhase2Backfill({
      customerId,
      kind,
      fromIso: body.from,
      toIso: body.to,
    });
    await auditLog.record({
      actor: session.accountId,
      action: "aimer_phase2.backfill",
      target: "customer",
      targetId: String(customerId),
      ip: extractClientIp(request),
      sid: session.sessionId,
      customerId,
      details: {
        kind,
        from: body.from,
        to: body.to,
        enqueuedNoticeCount: result.enqueuedNoticeIds.length,
      },
    });
    return NextResponse.json({
      enqueued_notice_ids: result.enqueuedNoticeIds,
    });
  } catch (err) {
    if (err instanceof CustomerNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof Phase2BackfillMultiVersionError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "backfill_failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});
