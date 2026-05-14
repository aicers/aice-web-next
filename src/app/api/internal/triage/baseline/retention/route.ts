import "server-only";

import { NextResponse } from "next/server";

import {
  runBaselineRetentionDispatch,
  verifyTriageBaselineRetentionToken,
} from "@/lib/triage/baseline/retention";

/**
 * POST /api/internal/triage/baseline/retention
 *
 * Token-protected entrypoint the deployment scheduler hits at the
 * retention cadence (daily). Enumerates active customers, then runs
 * the corpus A retention sweep against each tenant DB:
 *
 *   - `baseline_triaged_event` rows older than 180 days from
 *     `event_time` are deleted.
 *   - `observed_event_meta` rows older than 30 days from `event_time`
 *     are deleted.
 *
 * Per-customer failures are reflected in the `perCustomer[]` entry;
 * the dispatcher itself only throws when active-customer enumeration
 * fails. Status codes mirror `triage/baseline/dispatch`: 200 on
 * dispatcher success even when one customer's sweep failed, 401 on
 * token mismatch, 500 only on dispatcher self-failure.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ")
    ? auth.slice("Bearer ".length).trim()
    : null;
  if (!verifyTriageBaselineRetentionToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runBaselineRetentionDispatch();
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Retention failed";
    return NextResponse.json(
      { overall: "failed", error: message, perCustomer: [] },
      { status: 500 },
    );
  }
}
