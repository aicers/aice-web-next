import "server-only";

import { NextResponse } from "next/server";

import {
  consumeManualMintAndBumpBeta,
  ManualMintConsumeError,
  storyExistsForCustomer,
} from "@/lib/aimer/phase2/manual-mint";
import { auditLog } from "@/lib/audit/logger";
import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import { withAuth } from "@/lib/auth/guard";
import { hasPermission } from "@/lib/auth/permissions";

/**
 * `POST /api/aimer/phase2/story/ack-manual` (#493).
 *
 * Manual Send finalize hop. The browser calls this after aimer-web
 * returns 2xx for a `build-envelope` push, carrying the originating
 * `contextJti` + `customerId` + `storyId` + `forceRefresh` (echoed) +
 * `duplicatesSkipped` (from aimer-web's batch response).
 *
 * One tenant-DB transaction covers:
 *
 *  1. Consume the `aimer_phase2_manual_mint` ledger row matching
 *     `(contextJti, storyId, accountId)` with `consumed_at IS NULL`
 *     — sets `consumed_at = NOW()`. A missing row OR a row already
 *     consumed → 409 `replay_or_unknown_jti`. The `force_refresh`
 *     claim used for the audit row is read from the ledger, not the
 *     request body, so a tampered `forceRefresh: true` on the
 *     request cannot upgrade an originally-non-force send.
 *  2. Bump `event_group` β columns:
 *     `last_sent_at = NOW()`, `last_sent_by = <caller account_id>`,
 *     `send_count = send_count + 1`.
 *
 * After the transaction commits, emit one `triage.story.send` audit
 * row best-effort (the audit DB is separate and cannot be co-
 * committed). Returns the new β snapshot so the Story card can
 * render without a full menu refresh.
 */

interface RequestBody {
  customerId?: unknown;
  storyId?: unknown;
  contextJti?: unknown;
  forceRefresh?: unknown;
  duplicatesSkipped?: unknown;
}

function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

function isDecimalString(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && /^[0-9]+$/.test(value)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export const POST = withAuth(
  async (request, _context, session) => {
    let body: RequestBody;
    try {
      body = (await request.json()) as RequestBody;
    } catch {
      return jsonError("invalid_json", 400);
    }

    if (
      typeof body.customerId !== "number" ||
      !Number.isInteger(body.customerId) ||
      body.customerId <= 0
    ) {
      return jsonError("invalid_customer_id", 400);
    }
    const customerId = body.customerId;

    if (!isDecimalString(body.storyId)) {
      return jsonError("invalid_story_id", 400);
    }
    const storyId = body.storyId;

    if (!isNonEmptyString(body.contextJti)) {
      return jsonError("invalid_context_jti", 400);
    }
    const contextJti = body.contextJti;

    const duplicatesSkipped =
      typeof body.duplicatesSkipped === "number" &&
      Number.isFinite(body.duplicatesSkipped)
        ? body.duplicatesSkipped
        : 0;

    // Tenant scope guard: a `triage:read` user for tenant A cannot
    // commit β for tenant B's Story. Admin (`customers:access-all`)
    // bypasses.
    const isAdmin = await hasPermission(session.roles, "customers:access-all");
    if (!isAdmin) {
      const ids = await resolveEffectiveCustomerIds(
        session.accountId,
        session.roles,
      );
      if (!ids.includes(customerId)) {
        return jsonError("not_found", 404);
      }
    }

    // Existence pre-check so the 404 surface is distinguishable from
    // the JTI-replay surface (a forged JTI for a *missing* story
    // gives 404 here; a forged JTI for an *existing* story gives 409
    // below). Both block the commit; the two error codes carry
    // useful diagnostic context for the operator.
    if (!(await storyExistsForCustomer(customerId, storyId))) {
      return jsonError("story_not_found", 404);
    }

    let result: Awaited<ReturnType<typeof consumeManualMintAndBumpBeta>>;
    try {
      result = await consumeManualMintAndBumpBeta(customerId, {
        contextJti,
        storyId,
        accountId: session.accountId,
      });
    } catch (err) {
      if (err instanceof ManualMintConsumeError) {
        if (err.code === "story_not_found") {
          return jsonError("story_not_found", 404);
        }
        return jsonError(err.code, 409);
      }
      throw err;
    }

    // Audit emission is best-effort outside the tenant transaction.
    // The audit DB is separate from the tenant DB so a crash between
    // the two writes leaves β advanced without an audit row — the
    // tenant DB carries the canonical β state and the cross-side
    // `aimer_phase2.ingest` audit on aimer-web records the same
    // event (#493 "Manual mint ledger" rationale).
    try {
      await auditLog.record({
        actor: session.accountId,
        action: "triage.story.send",
        target: "triage_story",
        targetId: storyId,
        customerId,
        sid: session.sessionId,
        details: {
          customerId,
          storyId,
          storyVersion: result.storyVersion,
          forceRefresh: result.forceRefresh,
          duplicatesSkipped,
          trigger: "manual",
        },
      });
    } catch (err) {
      console.error("triage.story.send audit emission failed", err);
    }

    return NextResponse.json({
      lastSentAtIso: result.lastSentAtIso,
      sendCount: result.sendCount,
    });
  },
  {
    requiredPermissions: ["triage:read"],
  },
);
