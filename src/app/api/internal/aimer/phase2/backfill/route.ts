import "server-only";

import { NextResponse } from "next/server";

import {
  type Phase2BackfillKind,
  Phase2BackfillMultiVersionError,
  runPhase2Backfill,
  verifyPhase2BackfillToken,
} from "@/lib/aimer/phase2/backfill";
import { BASELINE_TRIAGED_EVENT_RETENTION_DAYS } from "@/lib/triage/baseline/retention";
import { CustomerNotFoundError } from "@/lib/triage/policy/customer-db";

/**
 * Hard bound on how far back a backfill window may reach. Pinned to the
 * `baseline_triaged_event` retention window (180 days; see
 * `BASELINE_TRIAGED_EVENT_RETENTION_DAYS`) so a backfill cannot ask for
 * a range whose source rows have already been swept. Stories are derived
 * from baseline events and inherit the same effective horizon — an
 * older Story window would either have no rows or rows whose underlying
 * members are gone. If retention is ever raised, this constant follows
 * automatically; if a deployment needs an independently longer bound,
 * lift this to an env var.
 */
const PHASE2_BACKFILL_MAX_AGE_MS =
  BASELINE_TRIAGED_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Allow a small clock-skew slack on the future-rejection check so an
 * operator-supplied `to` of "right now" cannot be tripped by sub-second
 * drift between the operator's clock and the server's.
 */
const PHASE2_BACKFILL_FUTURE_SKEW_MS = 60_000;

/**
 * POST /api/internal/aimer/phase2/backfill
 *
 * Internal-token-guarded admin route that seeds aimer-web with a
 * historical baseline / story window after Phase 2 activation. Same
 * shape as a `refresh_*_window` payload but enqueued under a
 * `backfill_*_window` queue kind so the drain routes to
 * `/api/phase2/backfill` (audit-distinct from refresh).
 *
 * Body:
 *
 *     { "customer_id": <int>,
 *       "kind": "baseline_event" | "story",
 *       "from": <ISO>, "to": <ISO> }
 *
 * Status codes:
 *   - 200 with `{ "enqueued_notice_ids": ["<id>", ...] }` on success.
 *   - 400 on malformed body / unknown kind / inverted window.
 *   - 401 when the bearer token does not verify (also when the env
 *     var is unset — the deployment must explicitly opt in).
 *   - 404 when the supplied `customer_id` is unknown / not active.
 *   - 500 on DB error during payload construction or enqueue.
 *
 * Auth: `Authorization: Bearer <AIMER_PHASE2_BACKFILL_INTERNAL_TOKEN>`,
 * constant-time-compared. Separate token from
 * `APPLY_INTERNAL_CLEANUP_TOKEN` so the two surfaces can rotate /
 * audit independently.
 */

interface ParsedBody {
  customerId: number;
  kind: Phase2BackfillKind;
  fromIso: string;
  toIso: string;
}

export async function POST(request: Request): Promise<NextResponse> {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ")
    ? auth.slice("Bearer ".length).trim()
    : null;
  if (!verifyPhase2BackfillToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = parseBody(raw);
  if (typeof parsed === "string") {
    return NextResponse.json({ error: parsed }, { status: 400 });
  }

  try {
    const result = await runPhase2Backfill({
      customerId: parsed.customerId,
      kind: parsed.kind,
      fromIso: parsed.fromIso,
      toIso: parsed.toIso,
    });
    return NextResponse.json({
      enqueued_notice_ids: result.enqueuedNoticeIds,
    });
  } catch (err) {
    if (err instanceof CustomerNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof Phase2BackfillMultiVersionError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "Backfill failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function parseBody(body: unknown): ParsedBody | string {
  if (!body || typeof body !== "object") {
    return "Body must be { customer_id: <positive integer>, kind: baseline_event | story, from: <ISO>, to: <ISO> }";
  }
  const obj = body as Record<string, unknown>;
  const customerIdRaw = obj.customer_id;
  if (
    typeof customerIdRaw !== "number" ||
    !Number.isInteger(customerIdRaw) ||
    customerIdRaw <= 0
  ) {
    return "customer_id must be a positive integer";
  }
  const kindRaw = obj.kind;
  if (kindRaw !== "baseline_event" && kindRaw !== "story") {
    return "kind must be 'baseline_event' or 'story'";
  }
  const from = obj.from;
  const to = obj.to;
  if (typeof from !== "string" || typeof to !== "string") {
    return "from and to must be ISO-8601 strings";
  }
  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return "from and to must be valid ISO-8601 timestamps";
  }
  if (fromDate.getTime() >= toDate.getTime()) {
    return "from must be strictly before to";
  }
  // Reject windows outside the allowed bounds (#573 acceptance
  // criteria). A future `to` would enqueue an empty refresh that
  // tells aimer-web to clear that window — meaningless and
  // potentially destructive. A `from` older than the baseline corpus
  // retention horizon would yield an empty/partial replacement (the
  // local rows have been swept), which silently mislabels the older
  // window as "no events."
  const nowMs = Date.now();
  if (toDate.getTime() > nowMs + PHASE2_BACKFILL_FUTURE_SKEW_MS) {
    return "to must not extend into the future";
  }
  if (fromDate.getTime() < nowMs - PHASE2_BACKFILL_MAX_AGE_MS) {
    return `from must not be older than ${PHASE2_BACKFILL_MAX_AGE_MS / (24 * 60 * 60 * 1000)} days`;
  }
  return {
    customerId: customerIdRaw,
    kind: kindRaw,
    fromIso: from,
    toIso: to,
  };
}
