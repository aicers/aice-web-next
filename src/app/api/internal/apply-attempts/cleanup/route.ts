import "server-only";

import { NextResponse } from "next/server";

import {
  runApplyAttemptCleanup,
  verifyInternalCleanupToken,
} from "@/lib/node/apply-attempt-cleanup";

/**
 * POST /api/internal/apply-attempts/cleanup
 *
 * Drives every cleanup sweep (stale-lock recovery → TTL terminalisation
 * → retention deletion) in a single transaction. Designed to be invoked
 * by the deployment scheduler on a fixed cadence so cleanup runs even
 * when the Next.js process is otherwise idle (which the startup +
 * inline-pre-create fallback would miss on a multi-instance deployment
 * where one instance is idle and another is creating attempts).
 *
 * Internal-token guarded: the request must carry
 * `Authorization: Bearer <APPLY_INTERNAL_CLEANUP_TOKEN>` matching the
 * env var. The shared secret is constant-time-compared to avoid a
 * timing oracle. If the env var is unset the route refuses every
 * request — the deployment must explicitly set the token.
 *
 * Response body: `{ recovered, expired, purged, auditsRecovered }`
 * (per-sweep counts). `auditsRecovered` is the number of `succeeded`
 * rows whose `node.apply` audit had not yet been emitted at the time
 * of the sweep and which the audit-recovery pass re-emitted before
 * the retention purge ran (see `recoverPendingNodeApplyAudits`).
 *
 * Cleanup security: the helper runs as a system actor and never reads
 * or writes the manager DB and never dispatches to external services.
 * The acceptance test asserts zero outbound GraphQL during a pass.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ")
    ? auth.slice("Bearer ".length).trim()
    : null;
  if (!verifyInternalCleanupToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await runApplyAttemptCleanup();
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Cleanup failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
