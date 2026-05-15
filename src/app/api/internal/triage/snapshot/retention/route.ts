import "server-only";

import { NextResponse } from "next/server";

import {
  runSnapshotRetentionDispatch,
  verifyTriageSnapshotRetentionToken,
} from "@/lib/triage/snapshot/retention";

/**
 * POST /api/internal/triage/snapshot/retention
 *
 * Token-protected entrypoint the deployment scheduler hits on the
 * snapshot retention cadence. Enumerates active customers and runs
 * the snapshot cleanup sweep against each tenant DB:
 *
 *   - `exclusion_snapshot` rows past the grace cutoff (corpus A
 *     retention + 30d) AND unreferenced by `baseline_triaged_event`
 *     or `policy_triage_run` are deleted.
 *   - `policy_snapshot` rows past the grace cutoff (corpus B ready
 *     retention + 30d) AND unreferenced by `policy_triage_run` are
 *     deleted.
 *   - `baseline_version_snapshot` is retained forever (small,
 *     valuable, no realistic growth concern) — the sweep skips it.
 *
 * Per-customer failures are reflected in the `perCustomer[]` entry;
 * the dispatcher itself only throws when active-customer enumeration
 * fails. Status codes mirror the corpus A / B retention routes:
 * 200 on dispatcher success even when one customer's sweep failed,
 * 401 on token mismatch, 500 only on dispatcher self-failure.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ")
    ? auth.slice("Bearer ".length).trim()
    : null;
  if (!verifyTriageSnapshotRetentionToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runSnapshotRetentionDispatch();
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Retention failed";
    return NextResponse.json(
      { overall: "failed", error: message, perCustomer: [] },
      { status: 500 },
    );
  }
}
