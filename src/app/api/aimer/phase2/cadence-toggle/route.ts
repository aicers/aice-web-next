import "server-only";

import { NextResponse } from "next/server";
import { setCadenceEnabled } from "@/lib/aimer/phase2/state";
import { isSystemAdministrator } from "@/lib/aimer/role-guard";
import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import { withAuth } from "@/lib/auth/guard";

/**
 * `POST /api/aimer/phase2/cadence-toggle`
 *
 * Per-customer cadence consent toggle for the Settings page (#651).
 * Flips `cadence_enabled` on both streaming-kind `aimer_push_state` rows
 * (`baseline_event`, `story`) in one statement — there is a single
 * logical per-customer toggle even though the column is per-kind. The
 * app-shell cadence manager reads the flag (via
 * `GET /api/aimer/phase2/cadence-config`) to decide whether to start the
 * 5-minute opportunistic drain for the customer while the operator is
 * signed in.
 *
 * Default off (opt-in). This flag is orthogonal to
 * `opportunistic_enabled` (the route-level pause gate) — toggling
 * cadence never changes pause state, and "Sync now" works regardless of
 * cadence state.
 *
 * Body: `{ "customer_id": <positive integer>, "enabled": <boolean> }`.
 * Response: `204 No Content` on success.
 * Gated by {@link isSystemAdministrator}.
 */

interface RequestBody {
  customer_id?: unknown;
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
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: "enabled must be a boolean" },
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

  await setCadenceEnabled(customerId, body.enabled);

  return new NextResponse(null, { status: 204 });
});
