import "server-only";

import { NextResponse } from "next/server";

import {
  runPolicyRetentionDispatch,
  verifyTriagePolicyRetentionToken,
} from "@/lib/triage/policy/corpus-b/retention";

/**
 * POST /api/internal/triage/policy/retention
 *
 * Token-protected entrypoint the deployment scheduler hits at the
 * policy retention cadence. Enumerates active customers and runs the
 * corpus B retention sweep against each tenant DB:
 *
 *   - zombie-runner reaper: `computing` rows older than 30 minutes
 *     become `failed` with `last_error = 'timeout: runner did not
 *     finalize'`. Reverses the runner crash via the partial unique
 *     index so a fresh fingerprint run can proceed.
 *   - differential retention: ready 30d / superseded 7d / failed 1d.
 *   - orphan cleanup: rows whose `owner_account_id` no longer resolves
 *     in `auth_db.accounts`.
 *
 * `policy_triaged_event` rows cascade with their run, so pruning a run
 * removes its events in the same transaction.
 *
 * Status codes match the other retention routes: 200 on dispatcher
 * success (even with per-customer failures); 401 on token mismatch;
 * 500 on dispatcher self-failure.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ")
    ? auth.slice("Bearer ".length).trim()
    : null;
  if (!verifyTriagePolicyRetentionToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runPolicyRetentionDispatch();
    return NextResponse.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Policy retention failed";
    return NextResponse.json(
      { overall: "failed", error: message, perCustomer: [] },
      { status: 500 },
    );
  }
}
