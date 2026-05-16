import "server-only";

import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/guard";
import {
  callerCanAccessCustomer,
  ingestEngagementAction,
  ingestImpressionBatch,
} from "@/lib/triage/engagement/ingest";
import {
  EngagementValidationError,
  parseAction,
  parseImpressionBatch,
} from "@/lib/triage/engagement/parse";

/**
 * POST /api/triage/engagement
 *
 * Single endpoint that ingests both engagement streams (impressions
 * and actions) per the two-shape body discriminator on `kind`.
 *
 *   { kind: "impressions", customerId, menuLoadId, strictnessStop,
 *     surface, periodStartIso, periodEndIso, impressions: [...] }
 *
 *   { kind: "action", action: { type, customerId, surface, ... } }
 *
 * The client is expected to invoke this endpoint as fire-and-forget —
 * any non-2xx response is logged client-side and discarded so the
 * Triage UI never surfaces an ingestion error. Errors here therefore
 * still return useful 4xx/5xx codes so they can be observed in HAR /
 * server logs, but UI consumers do not propagate them.
 *
 * Customer-scope check matches the existing exclusions route: the
 * caller must hold `customers:access-all` or have an explicit
 * `account_customer` row for the target customer.
 */
export const POST = withAuth(
  async (request, _context, session) => {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw) ||
      typeof (raw as { kind?: unknown }).kind !== "string"
    ) {
      return NextResponse.json(
        { error: "Body must include a string `kind`" },
        { status: 400 },
      );
    }
    const kind = (raw as { kind: string }).kind;
    if (kind === "impressions") {
      let batch: ReturnType<typeof parseImpressionBatch>;
      try {
        batch = parseImpressionBatch(raw);
      } catch (err) {
        if (err instanceof EngagementValidationError) {
          return NextResponse.json({ error: err.message }, { status: 400 });
        }
        throw err;
      }
      if (
        !(await callerCanAccessCustomer(
          session.accountId,
          session.roles,
          batch.customerId,
        ))
      ) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      try {
        const result = await ingestImpressionBatch(session.accountId, batch);
        return NextResponse.json(result, { status: 202 });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Structured drop: the chosen handling mechanism for ingest
        // failures (#588 acceptance). The client will retry on the
        // next menu load if it cares; replays are idempotent on
        // `(menu_load_id, event_key)`.
        console.error(
          "[engagement] impression ingest failed customer=%d batch=%s err=%s",
          batch.customerId,
          batch.menuLoadId,
          message,
        );
        return NextResponse.json({ error: "Ingest failed" }, { status: 500 });
      }
    }
    if (kind === "action") {
      let action: ReturnType<typeof parseAction>;
      try {
        action = parseAction(raw);
      } catch (err) {
        if (err instanceof EngagementValidationError) {
          return NextResponse.json({ error: err.message }, { status: 400 });
        }
        throw err;
      }
      if (
        !(await callerCanAccessCustomer(
          session.accountId,
          session.roles,
          action.customerId,
        ))
      ) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      try {
        await ingestEngagementAction(session.accountId, action);
        return NextResponse.json({}, { status: 202 });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          "[engagement] action ingest failed customer=%d type=%s err=%s",
          action.customerId,
          action.type,
          message,
        );
        return NextResponse.json({ error: "Ingest failed" }, { status: 500 });
      }
    }
    return NextResponse.json(
      { error: `Unknown kind "${kind}"` },
      { status: 400 },
    );
  },
  { requiredPermissions: ["triage:read"] },
);
