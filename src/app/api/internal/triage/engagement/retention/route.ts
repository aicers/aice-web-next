import "server-only";

import { NextResponse } from "next/server";

import {
  runEngagementRetentionDispatch,
  verifyTriageEngagementRetentionToken,
} from "@/lib/triage/engagement/retention";

/**
 * POST /api/internal/triage/engagement/retention
 *
 * Token-protected entrypoint the deployment scheduler hits on the
 * engagement retention cadence (daily). Enumerates active
 * customers, then runs the engagement-signal sweep against each
 * tenant DB:
 *
 *   - `engagement_impression` rows older than 90 days from
 *     `created_at` are deleted.
 *   - `engagement_action` rows older than 180 days from
 *     `created_at` are deleted.
 *
 * Per-customer failures are reflected in the `perCustomer[]`
 * entry; the dispatcher itself only throws when active-customer
 * enumeration fails. Status codes mirror the corpus / snapshot
 * retention routes: 200 on dispatcher success even when one
 * customer's sweep failed, 401 on token mismatch, 500 only on
 * dispatcher self-failure.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ")
    ? auth.slice("Bearer ".length).trim()
    : null;
  if (!verifyTriageEngagementRetentionToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runEngagementRetentionDispatch();
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Retention failed";
    return NextResponse.json(
      { overall: "failed", error: message, perCustomer: [] },
      { status: 500 },
    );
  }
}
