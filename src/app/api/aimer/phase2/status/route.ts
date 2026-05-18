import "server-only";

import { NextResponse } from "next/server";

import { buildPhase2StatusDto } from "@/lib/aimer/phase2/status";
import { isSystemAdministrator } from "@/lib/aimer/role-guard";
import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import { withAuth } from "@/lib/auth/guard";

/**
 * `GET /api/aimer/phase2/status?customer_id=<id>`
 *
 * Per-customer Phase 2 status indicator (#620). Returns the three-track
 * shape consumed by the Settings status block:
 *
 *   - `streaming` — array with `baseline_event` and `story` cursors:
 *     bucket label, last synced, approximate backlog, pending queue
 *     count, last error, pause state.
 *   - `policy_run` — manual-only kind: last sent run id + timestamp +
 *     actor + total runs sent.
 *   - `policy_event` — queue-only kind: pending count + most recent
 *     unack'd row's `last_error`.
 *
 * Queue payload bodies are never returned. Gated by
 * {@link isSystemAdministrator} per #620 §Permissions (uses the
 * role-name gate, not `system-settings:*`, to preserve the
 * Aimer-integration trust boundary documented in `role-guard.ts`).
 */
export const GET = withAuth(async (request, _context, session) => {
  if (!isSystemAdministrator(session.roles)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const customerIdRaw = new URL(request.url).searchParams.get("customer_id");
  const customerId = Number(customerIdRaw);
  if (!customerIdRaw || !Number.isInteger(customerId) || customerId <= 0) {
    return NextResponse.json(
      { error: "customer_id must be a positive integer" },
      { status: 400 },
    );
  }

  // The System Administrator role grants `customers:access-all` by
  // assignment, but resolve explicitly so a future role-config change
  // does not silently widen the route's customer scope.
  const ids = await resolveEffectiveCustomerIds(
    session.accountId,
    session.roles,
  );
  if (!ids.includes(customerId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const dto = await buildPhase2StatusDto(customerId);
    return NextResponse.json(dto, {
      headers: {
        // Settings polls this every few seconds; the consumer may add
        // its own ETag / SWR but the server should not let stale CDN
        // caches serve cross-operator data.
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "status_failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});
