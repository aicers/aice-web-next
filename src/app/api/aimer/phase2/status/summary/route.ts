import "server-only";

import { NextResponse } from "next/server";

import { buildPhase2StatusSummary } from "@/lib/aimer/phase2/status";
import { isSystemAdministrator } from "@/lib/aimer/role-guard";
import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import { withAuth } from "@/lib/auth/guard";
import { query } from "@/lib/db/client";

/**
 * `GET /api/aimer/phase2/status/summary`
 *
 * Cross-customer aggregate consumed by the app-shell login banner
 * (#620). The banner must answer "is any customer behind?" in one
 * round trip from a context where no customer is selected yet, so the
 * per-customer route is not enough.
 *
 * Returns a compact list: one row per customer in `behind` /
 * `way_behind` / `paused` state with `customer_id`, the worst per-kind
 * bucket, and the kinds that contributed. Empty `customers` → banner
 * hidden.
 *
 * Per-customer work is bounded (no `approximate_count` fast-path), the
 * fan-out runs under a concurrency cap, and the response is cached
 * process-locally for a short TTL — see
 * {@link buildPhase2StatusSummary}. Gated by
 * {@link isSystemAdministrator}, same as the per-customer route.
 *
 * The route is called client-side after first paint; it never blocks
 * SSR or the initial document render.
 */
export const GET = withAuth(async (_request, _context, session) => {
  if (!isSystemAdministrator(session.roles)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const effectiveIds = await resolveEffectiveCustomerIds(
    session.accountId,
    session.roles,
  );
  // `resolveEffectiveCustomerIds` returns every registered customer for a
  // System Administrator, including `status != 'active'` tenants. The
  // Settings page only renders active customers in the Phase 2 picker, so
  // a paused or behind row on an inactive tenant would warn an operator
  // about a customer they cannot select. Filter the banner's input to the
  // same active-customer set the Settings page uses.
  const customerIds = await filterActiveCustomerIds(effectiveIds);

  try {
    const dto = await buildPhase2StatusSummary(customerIds);
    return NextResponse.json(dto, {
      headers: {
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "summary_failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});

async function filterActiveCustomerIds(
  ids: readonly number[],
): Promise<number[]> {
  if (ids.length === 0) return [];
  const { rows } = await query<{ id: number }>(
    `SELECT id FROM customers
      WHERE id = ANY($1::int[]) AND status = 'active'
      ORDER BY id`,
    [ids as unknown as number[]],
  );
  return rows.map((r) => r.id);
}
