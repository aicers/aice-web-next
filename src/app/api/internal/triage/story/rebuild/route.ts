import "server-only";

import { NextResponse } from "next/server";

import { CustomerNotFoundError } from "@/lib/triage/policy/customer-db";
import {
  runStoryRebuild,
  StoryRebuildBusyError,
  StoryRebuildInvalidRangeError,
  verifyTriageStoryRebuildToken,
} from "@/lib/triage/story/rebuild";

/**
 * POST /api/internal/triage/story/rebuild
 *
 * Internal-token-guarded entry point that re-runs the heuristic
 * Story correlator for a single customer over a `[from, to)` window.
 * The route runs as a system actor — no audit log, no UI — matching
 * the template used by the other internal triage routes
 * (`triage/baseline/cadence`, `triage/baseline/dispatch`,
 * `triage/exclusion/fanout`).
 *
 * Body:
 *
 *     { "customer_id": <number>, "from": <ISO>, "to": <ISO> }
 *
 * `from`/`to` are ISO-8601 timestamps; the range is half-open
 * `[from, to)` and is interpreted against
 * `event_group.time_window_end`. Auto Stories in the range are
 * DELETEd, the correlator is re-run over
 * `[from − MAX_RULE_WINDOW_MS, to)`, and replacements are INSERTed
 * with β-style submission tracking carried over from any matching
 * pre-rebuild row.
 *
 * Status codes:
 *   - 200 with `{ deletedAutoStories, insertedAutoStories,
 *     skippedCuratedStories, betaCarriedOver, durationMs, warnings }`
 *     on success.
 *   - 400 when the request body is invalid or the range is empty /
 *     inverted.
 *   - 401 when the bearer token does not verify.
 *   - 404 when the supplied `customer_id` is unknown / not active.
 *   - 409 when the per-customer advisory lock is held by cadence,
 *     the baseline rebuild, exclusion-ADD, or another Story rebuild.
 *   - 500 with `{ error }` when the rebuild rolled back.
 */

interface ParsedBody {
  customerId: number;
  fromIso: string;
  toIso: string;
}

export async function POST(request: Request): Promise<NextResponse> {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ")
    ? auth.slice("Bearer ".length).trim()
    : null;
  if (!verifyTriageStoryRebuildToken(token)) {
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
    const result = await runStoryRebuild({
      customerId: parsed.customerId,
      fromIso: parsed.fromIso,
      toIso: parsed.toIso,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof StoryRebuildBusyError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof StoryRebuildInvalidRangeError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof CustomerNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    const message = err instanceof Error ? err.message : "Story rebuild failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function parseBody(body: unknown): ParsedBody | string {
  if (!body || typeof body !== "object") {
    return "Body must be { customer_id: <positive integer>, from: <ISO>, to: <ISO> }";
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
  return {
    customerId: customerIdRaw,
    fromIso: from,
    toIso: to,
  };
}
