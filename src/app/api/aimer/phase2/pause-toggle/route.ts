import "server-only";

import { NextResponse } from "next/server";

import {
  getAimerPushState,
  type Phase2StreamingKind,
  setOpportunisticEnabled,
} from "@/lib/aimer/phase2/state";
import { isSystemAdministrator } from "@/lib/aimer/role-guard";
import { auditLog } from "@/lib/audit/logger";
import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";

/**
 * `POST /api/aimer/phase2/pause-toggle`
 *
 * Session-authenticated wrapper around #570's `setOpportunisticEnabled`
 * (#620 streaming-kind pause toggle). Flips
 * `aimer_push_state.opportunistic_enabled` for `baseline_event` or
 * `story` and emits the corresponding audit row:
 *
 *   - `enabled: false` → `aimer_phase2.opportunistic_paused`.
 *   - `enabled: true` → `aimer_phase2.opportunistic_resumed` with
 *     `pausedDurationSeconds` (NOW − `paused_at`) when resumable.
 *
 * Only the streaming kinds are pausable — `policy_run` is manual-only
 * and `policy_event` is queue-only with no opportunistic background
 * drain, so they have no pause toggle by design.
 *
 * Body:
 *   `{ "customer_id": <int>, "kind": "baseline_event" | "story",
 *      "enabled": <bool> }`
 * Response: `200 { ok: true }`. Gated by {@link isSystemAdministrator}.
 */

interface RequestBody {
  customer_id?: unknown;
  kind?: unknown;
  enabled?: unknown;
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
  const kind: Phase2StreamingKind = body.kind;

  if (typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: "enabled must be a boolean" },
      { status: 400 },
    );
  }
  const enabled = body.enabled;

  const ids = await resolveEffectiveCustomerIds(
    session.accountId,
    session.roles,
  );
  if (!ids.includes(customerId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Read prior state BEFORE flipping so the resume path can compute
  // `pausedDurationSeconds` from the soon-to-be-cleared `paused_at`
  // timestamp.
  const prior = await getAimerPushState(customerId, kind);
  await setOpportunisticEnabled(customerId, kind, enabled, session.accountId);

  if (enabled) {
    const pausedDurationSeconds =
      prior?.paused_at !== null && prior?.paused_at !== undefined
        ? Math.max(
            0,
            Math.floor((Date.now() - prior.paused_at.getTime()) / 1000),
          )
        : null;
    await auditLog.record({
      actor: session.accountId,
      action: "aimer_phase2.opportunistic_resumed",
      target: "customer",
      targetId: String(customerId),
      ip: extractClientIp(request),
      sid: session.sessionId,
      customerId,
      details: { kind, pausedDurationSeconds },
    });
  } else {
    await auditLog.record({
      actor: session.accountId,
      action: "aimer_phase2.opportunistic_paused",
      target: "customer",
      targetId: String(customerId),
      ip: extractClientIp(request),
      sid: session.sessionId,
      customerId,
      details: { kind },
    });
  }

  return NextResponse.json({ ok: true });
});
