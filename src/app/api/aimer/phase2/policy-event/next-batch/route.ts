import "server-only";

import { NextResponse } from "next/server";

import { buildPhase2Push } from "@/lib/aimer/phase2/orchestrate";
import {
  type AimerPushQueueRow,
  claimPendingNotices,
  commitOnAck,
  insertInflight,
  pruneExpiredInflight,
  recordOnFail,
} from "@/lib/aimer/phase2/state";
import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import { withAuth } from "@/lib/auth/guard";
import { hasPermission } from "@/lib/auth/permissions";

/**
 * `POST /api/aimer/phase2/policy-event/next-batch`
 *
 * Example queue-only drain route per RFC 0002 §7 and sub-issue #592.
 * Drains pending `withdraw_policy_event` rows from `aimer_push_queue`,
 * signs them as a single `phase2.withdraw.v1` envelope, and threads
 * inflight ack state via `aimer_push_inflight`. Policy_event is
 * queue-only — no cursor on `aimer_push_state`, no pause semantics.
 *
 * Per-call protocol (RFC 0002 §7 "Browser-driven drain loop"):
 *
 *  1. Process the previous batch's outcome:
 *     - `acked_context_jti` → {@link commitOnAck} marks the queue rows
 *       ack'd and deletes the inflight row.
 *     - `failed_context_jti` → {@link recordOnFail} increments
 *       `attempts` / writes `last_error` on the queue rows and deletes
 *       the inflight row. (Does NOT call `recordSyncError` — there is
 *       no `aimer_push_state` row for `policy_event`.)
 *     - Both set in one call → 400 `mutually_exclusive`.
 *  2. Opportunistically prune expired inflight rows.
 *  3. Claim pending `withdraw_policy_event` rows.
 *  4. If none → `{ has_more: false, ...nulls }`.
 *  5. Otherwise → sign multipart via {@link buildPhase2Push}, insert an
 *     inflight row keyed on the freshly minted `context_jti`, return
 *     the multipart components + `aimer_endpoint_path` + `context_jti`.
 *
 * Audit attribution: the context-token `sub` claim remains the real
 * session `account_id` here (the wire-level identity); the
 * `SYSTEM_ACTOR_ACCOUNT_ID` sentinel applies to `last_sent_by` on
 * β-tracked tables, which this queue-only drain does not write.
 */

/** Max queue rows per response. */
const MAX_BATCH_SIZE = 100;

interface RequestBody {
  customerId?: unknown;
  acked_context_jti?: unknown;
  failed_context_jti?: unknown;
  failure_reason?: unknown;
}

interface SuccessBody {
  has_more: boolean;
  context_token: string | null;
  events_envelope: string | null;
  events_data: string | null;
  context_jti: string | null;
  aimer_endpoint_path: string | null;
  batch_jti: string | null;
  /**
   * Mirrors the envelope's `schema_version` claim per RFC 0002 §7
   * "next-batch route contract". Null when no work / paused; otherwise
   * the wire schema string the client logs alongside `batch_jti`.
   */
  schema_version: string | null;
}

const POLICY_EVENT_SCHEMA_VERSION = "phase2.withdraw.v1" as const;

const EMPTY_BODY: SuccessBody = {
  has_more: false,
  context_token: null,
  events_envelope: null,
  events_data: null,
  context_jti: null,
  aimer_endpoint_path: null,
  batch_jti: null,
  schema_version: null,
};

function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export const POST = withAuth(
  async (request, _context, session) => {
    // ── Parse body ────────────────────────────────────────────
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

    const ackedJti = isNonEmptyString(body.acked_context_jti)
      ? body.acked_context_jti
      : null;
    const failedJti = isNonEmptyString(body.failed_context_jti)
      ? body.failed_context_jti
      : null;
    if (ackedJti && failedJti) {
      // The contract permits at most one outcome per call: a single
      // batch is either ack'd or failed, not both.
      return jsonError("mutually_exclusive_ack_and_fail", 400);
    }

    // ── Customer access check ────────────────────────────────
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

    // ── Process prior batch outcome ──────────────────────────
    if (ackedJti) {
      await commitOnAck(customerId, ackedJti);
    } else if (failedJti) {
      const reason = isNonEmptyString(body.failure_reason)
        ? body.failure_reason
        : "policy_event_drain_failed";
      await recordOnFail(customerId, failedJti, reason);
    }

    // ── Opportunistic TTL prune ──────────────────────────────
    await pruneExpiredInflight(customerId);

    // ── Claim pending notices ────────────────────────────────
    const rows = await claimPendingNotices(customerId, "policy_event", {
      limit: MAX_BATCH_SIZE + 1,
    });
    if (rows.length === 0) {
      return NextResponse.json(EMPTY_BODY);
    }

    const claimed = rows.slice(0, MAX_BATCH_SIZE);
    const hasMore = rows.length > MAX_BATCH_SIZE;

    // ── Build wire payload ───────────────────────────────────
    //
    // The withdraw envelope groups all `policy_event` items in a
    // single signed batch. Each queue row's `payload` JSONB holds the
    // wire-ready `{ kind: "policy_event", run_id, event_keys }` item
    // (written by the upstream mutation hook in #573). The orchestration
    // helper threads `external_key` from the customer record.
    const withdrawals = claimed.map((row) => row.payload);
    const tokens = await buildPhase2Push({
      schemaVersion: POLICY_EVENT_SCHEMA_VERSION,
      customerId,
      accountId: session.accountId,
      // `external_key` is overwritten by the orchestrator from the
      // customer record, so any value here would be ignored. Pass a
      // placeholder to satisfy the schema's non-empty constraint.
      payload: { external_key: "_", withdrawals },
    });

    // ── Insert inflight ──────────────────────────────────────
    await insertInflight(customerId, {
      contextJti: tokens.context_jti,
      kind: "policy_event",
      cursorAdvanceToEventTime: null,
      cursorAdvanceToEventKey: null,
      queueRowIds: claimed.map((row: AimerPushQueueRow) => row.id),
    });

    const responseBody: SuccessBody = {
      has_more: hasMore,
      context_token: tokens.context_token,
      events_envelope: tokens.events_envelope,
      events_data: tokens.events_data,
      context_jti: tokens.context_jti,
      aimer_endpoint_path: "/api/phase2/withdraw",
      // `batch_jti` is an alias for `context_jti` per RFC 0002 §7
      // "Browser-driven drain loop" — surfaced under both names so the
      // client helper can read either field.
      batch_jti: tokens.context_jti,
      schema_version: POLICY_EVENT_SCHEMA_VERSION,
    };
    return NextResponse.json(responseBody);
  },
  {
    requiredPermissions: ["triage:read"],
  },
);
