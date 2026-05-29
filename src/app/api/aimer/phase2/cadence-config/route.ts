import "server-only";

import { NextResponse } from "next/server";

import { buildPhase2CadenceConfig } from "@/lib/aimer/phase2/status";
import { isSystemAdministrator } from "@/lib/aimer/role-guard";
import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import { withAuth } from "@/lib/auth/guard";

/**
 * `GET /api/aimer/phase2/cadence-config`
 *
 * Per-customer cadence-consent map for the app-shell cadence manager
 * (#651). Returns the in-scope customers whose `cadence_enabled` flag is
 * set, so the manager knows which customers to start a 5-minute
 * opportunistic {@link createPeriodicDrain} for while the operator is
 * signed in.
 *
 * Shape: `{ "customers": [{ "customer_id": <id>, "cadence_enabled": true }] }`.
 * Only opted-in customers are listed; an absent customer is treated as
 * opted out by the manager.
 *
 * Gated by {@link isSystemAdministrator} — the whole Phase 2 surface is
 * admin-only, matching the status/summary routes.
 */
export const GET = withAuth(async (_request, _context, session) => {
  if (!isSystemAdministrator(session.roles)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const ids = await resolveEffectiveCustomerIds(
    session.accountId,
    session.roles,
  );

  try {
    const dto = await buildPhase2CadenceConfig(ids);
    return NextResponse.json(dto, {
      headers: { "cache-control": "no-store" },
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "cadence_config_failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});
