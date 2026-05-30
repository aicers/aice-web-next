import "server-only";

import { NextResponse } from "next/server";

import { resolveAnalysisSummaryResponse } from "@/lib/aimer/analysis/summary-route";
import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import { withAuth } from "@/lib/auth/guard";
import { hasPermission } from "@/lib/auth/permissions";

/**
 * `GET /api/aimer/analysis/story/[customerId]/[storyId]/summary`
 *
 * AI narrative analysis badge resolver (RFC 0002 §"What aice-web-next
 * surfaces", aicers/aice-web-next#645). The Triage Stories surface calls
 * this once per visible Story to decide whether to render the deep-link
 * badge. The client treats anything other than `200` as "no badge".
 *
 * This route is a thin wrapper: parameter parsing, the story-id format
 * check, and tenant-scope concealment live here; the bridge-URL
 * composition, JWS attach, upstream fetch, field/link validation, and
 * 200/204 mapping live in the shared
 * {@link resolveAnalysisSummaryResponse} helper so the Phase 2 report
 * routes (#646) reuse the same composition (#653).
 *
 * Surfaces:
 * - `200 OK` with `{ exists: true, priority_tier, severity_score,
 *   likelihood_score, score_kind, link }` when the upstream report
 *   exists, the priority tier is `CRITICAL` or `HIGH`, and the upstream
 *   `link` validated as a relative path. `link` on the wire is the
 *   absolute aimer-web URL composed server-side.
 * - `204 No Content` for every other "render nothing" case (see the
 *   shared helper).
 * - `401` (no session — emitted by `withAuth`).
 * - `404 not_found` for cross-tenant `customerId` (concealment — matches
 *   the build-envelope route).
 *
 * Upstream contract (aicers/aimer-web#296, landed): customer-scoped
 * `GET /api/customers/{external_key}/analysis/story/{story_id}/summary`.
 */

function isDecimalString(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && /^[0-9]+$/.test(value)
  );
}

export const GET = withAuth(
  async (_request, context, session) => {
    const { customerId: customerIdParam, storyId: storyIdParam } =
      (await context.params) as { customerId?: string; storyId?: string };

    const customerId = Number(customerIdParam);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      return NextResponse.json(
        { error: "invalid_customer_id" },
        { status: 400 },
      );
    }
    if (!isDecimalString(storyIdParam)) {
      return NextResponse.json({ error: "invalid_story_id" }, { status: 400 });
    }
    const storyId = storyIdParam;

    // Tenant scope: a `triage:read` user for tenant A must not be able to
    // probe tenant B's report existence. Admins (`customers:access-all`)
    // skip. Non-admins out of scope get a 404 to keep the response
    // indistinguishable from "no such story" — matches the build-envelope
    // route's concealment surface.
    const isAdmin = await hasPermission(session.roles, "customers:access-all");
    if (!isAdmin) {
      const ids = await resolveEffectiveCustomerIds(
        session.accountId,
        session.roles,
      );
      if (!ids.includes(customerId)) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
    }

    return resolveAnalysisSummaryResponse({
      customerId,
      surface: "story",
      buildResourcePath: () =>
        `/analysis/story/${encodeURIComponent(storyId)}/summary`,
      logContext: `customerId=${customerId} storyId=${storyId}`,
    });
  },
  {
    requiredPermissions: ["triage:read"],
  },
);
