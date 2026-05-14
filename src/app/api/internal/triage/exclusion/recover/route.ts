import "server-only";

import { NextResponse } from "next/server";

import {
  applyRecover,
  emitRecoverAudit,
  type RecoverRequest,
  verifyTriageExclusionRecoveryToken,
} from "@/lib/triage/exclusion/recovery";

/**
 * POST /api/internal/triage/exclusion/recover
 *
 * Internal-token-guarded entrypoint cron / operator tooling uses to
 * reset failed fanout / drain-failure queue rows. The body is one of
 * three discriminated shapes:
 *
 *   { "kind": "global", "exclusion_id": <uuid>, "customer_id": <int> }
 *     Reset one specific failed `(global_exclusion_id, customer_id)` row.
 *
 *   { "kind": "global_all_failed", "exclusion_id": <uuid> }
 *     Reset every failed row for one global exclusion (operator sweep).
 *
 *   { "kind": "customer", "exclusion_id": <uuid>, "customer_id": <int> }
 *     Reset a customer-scoped drain-failure sentinel.
 *
 * `customer_id` is REQUIRED for `global` and `customer` modes; missing
 * it is a 400 rather than a sweep so a typo'd retry does not re-enqueue
 * work for every active customer. Mismatched shapes return 400.
 *
 * Audit emission: `triage_exclusion.global_recover` (customer-agnostic)
 * for `global` / `global_all_failed`, `triage_exclusion.customer_recover`
 * (customer-scoped) for `customer`. The audit row preserves the
 * historical record of the original failure even though the queue row
 * itself was reset in place.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ")
    ? auth.slice("Bearer ".length).trim()
    : null;
  if (!verifyTriageExclusionRecoveryToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = parseRecoverRequest(raw);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const outcome = await applyRecover(parsed.request);
    await emitRecoverAudit(parsed.request, "system", outcome.reset);
    return NextResponse.json({ reset: outcome.reset, kind: outcome.kind });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Recover failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

interface ParsedRequest {
  request: RecoverRequest;
}

interface ParseError {
  error: string;
}

function parseRecoverRequest(raw: unknown): ParsedRequest | ParseError {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "Body must be a JSON object" };
  }
  const body = raw as Record<string, unknown>;
  const kind = body.kind;
  if (typeof kind !== "string") {
    return { error: "Missing or invalid `kind`" };
  }
  const exclusionId = body.exclusion_id;
  if (typeof exclusionId !== "string" || exclusionId.length === 0) {
    return { error: "Missing or invalid `exclusion_id`" };
  }

  if (kind === "global_all_failed") {
    return { request: { kind, exclusionId } };
  }
  if (kind === "global" || kind === "customer") {
    const customerId = body.customer_id;
    if (
      typeof customerId !== "number" ||
      !Number.isInteger(customerId) ||
      customerId <= 0
    ) {
      return {
        error: "`customer_id` (positive integer) is required for this kind",
      };
    }
    return { request: { kind, exclusionId, customerId } };
  }
  return {
    error: "`kind` must be one of: 'global' | 'global_all_failed' | 'customer'",
  };
}
