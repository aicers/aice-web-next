import "server-only";

import { NextResponse } from "next/server";

import {
  enrichRefreshPayload,
  loadBaselineStreamingSlice,
} from "@/lib/aimer/phase2/baseline-push";
import { buildPhase2Push } from "@/lib/aimer/phase2/orchestrate";
import {
  type BaselineRefreshSubPayload,
  PHASE2_REFRESH_EXTERNAL_KEY_RESERVE_BYTES,
  PHASE2_REFRESH_PAYLOAD_MAX_BYTES,
} from "@/lib/aimer/phase2/payload-builders";
import {
  type AimerPushQueueRow,
  claimPendingNotices,
  commitOnAck,
  getAimerPushState,
  insertInflight,
  isOpportunisticEnabled,
  pruneExpiredInflight,
  recordOnFail,
} from "@/lib/aimer/phase2/state";
import type { Phase2SchemaVersion } from "@/lib/aimer/phase2/wire-types";
import { getAimerIntegrationSetup } from "@/lib/aimer/setup-status";
import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import { withAuth } from "@/lib/auth/guard";
import { hasPermission } from "@/lib/auth/permissions";

/**
 * `POST /api/aimer/phase2/baseline-event/next-batch`
 *
 * Streaming-kind drain route per RFC 0002 §7 and sub-issue #571.
 *
 * Per call:
 *
 *  1. Process the previous batch's outcome:
 *     - `acked_context_jti` → {@link commitOnAck} advances the
 *       `aimer_push_state.last_pushed_event_*` cursor (when the
 *       inflight row recorded one), marks any queue rows ack'd, and
 *       deletes the inflight row.
 *     - `failed_context_jti` → {@link recordOnFail} writes
 *       `aimer_push_state.last_error`, increments `attempts` /
 *       `last_error` on the queue rows, deletes the inflight row.
 *       Cursor is NOT advanced — the unchanged cursor re-issues the
 *       same slice on the next call.
 *     - Both → 400 `mutually_exclusive_ack_and_fail`.
 *  1a. If `aimer_push_state.opportunistic_enabled = FALSE` → return
 *      `{ has_more: false, paused: true, ...nulls }` so the controller
 *      treats this as a no-op interval and keeps polling.
 *  2. Opportunistically prune expired inflight rows.
 *  3. **Queue notices first.** If `aimer_push_queue` has pending rows
 *     for any of the three baseline queue kinds, claim the oldest
 *     pending row and emit it as this call's batch. Each queue kind
 *     maps 1:1 to one aimer-web endpoint + one wire schema_version —
 *     refresh / backfill carry pre-windowed payloads built by the
 *     mutation hook, so the route never aggregates across kinds.
 *  4. Otherwise (queue empty) load the next streaming slice past the
 *     `aimer_push_state` cursor and emit a `phase2.baseline.v1` batch
 *     enriched with `window_signals` / `score_window_context` /
 *     `asset_context` / `scoring_weights_snapshot` per RFC 0002 §6.
 *  5. Empty queue + empty slice → `{ has_more: false, ...nulls }`.
 *
 * `has_more` is true when either (a) more queued notices remain past
 * this call's batch, or (b) the streaming slice was trimmed by the
 * byte-budget (so the next iteration will pick up the tail), or
 * (c) the cursor read returned more rows than the loader emitted.
 */

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
  aimer_endpoint_url: string | null;
  batch_jti: string | null;
  schema_version: Phase2SchemaVersion | null;
  paused?: boolean;
}

const STREAMING_SCHEMA_VERSION: Phase2SchemaVersion = "phase2.baseline.v1";
const STREAMING_AIMER_PATH = "/api/phase2/baseline/batch" as const;

/**
 * Upper bound on queue rows aggregated into one withdraw envelope per
 * call. Refresh / backfill are emitted singly so the row limit only
 * binds on the withdraw path; the drain loop iterates past it. Note
 * that the byte budget {@link PHASE2_REFRESH_PAYLOAD_MAX_BYTES} also
 * binds the withdraw aggregation — whichever cap trips first wins.
 */
const MAX_QUEUE_PEEK = 100;

/**
 * Byte budget for withdraw aggregation. Matches the shared streaming /
 * refresh cap so a row that fits a streaming batch also fits a withdraw
 * envelope, with the same `external_key` reserve carved out so the
 * signed body still fits the cap.
 */
const WITHDRAW_PAYLOAD_BYTE_BUDGET = Math.max(
  1,
  PHASE2_REFRESH_PAYLOAD_MAX_BYTES - PHASE2_REFRESH_EXTERNAL_KEY_RESERVE_BYTES,
);

interface QueueKindMapping {
  schemaVersion: Phase2SchemaVersion;
  aimerEndpointPath: string;
}

const QUEUE_KIND_MAPPING: Record<
  | "withdraw_baseline_event"
  | "refresh_baseline_window"
  | "backfill_baseline_window",
  QueueKindMapping
> = {
  withdraw_baseline_event: {
    schemaVersion: "phase2.withdraw.v1",
    aimerEndpointPath: "/api/phase2/withdraw",
  },
  refresh_baseline_window: {
    schemaVersion: "phase2.refresh_window.v1",
    aimerEndpointPath: "/api/phase2/refresh-window",
  },
  backfill_baseline_window: {
    schemaVersion: "phase2.backfill.v1",
    aimerEndpointPath: "/api/phase2/backfill",
  },
};

const EMPTY_BODY: SuccessBody = {
  has_more: false,
  context_token: null,
  events_envelope: null,
  events_data: null,
  context_jti: null,
  aimer_endpoint_path: null,
  aimer_endpoint_url: null,
  batch_jti: null,
  schema_version: null,
};

const PAUSED_BODY: SuccessBody = {
  ...EMPTY_BODY,
  paused: true,
};

/**
 * Serialized byte length of a candidate withdraw envelope. Counts the
 * wrapping `{"external_key":"_","withdrawals":[...]}` JSON so the cap
 * matches the body we eventually sign.
 */
function serializeWithdrawals(withdrawals: readonly unknown[]): number {
  return Buffer.byteLength(
    JSON.stringify({ external_key: "_", withdrawals }),
    "utf8",
  );
}

function composeAimerEndpointUrl(
  bridgeUrl: string | null,
  path: string,
): string | null {
  if (!bridgeUrl) return null;
  const trimmed = bridgeUrl.replace(/\/+$/, "");
  return `${trimmed}${path}`;
}

function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
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

    const ackedJti = isNonEmptyString(body.acked_context_jti)
      ? body.acked_context_jti
      : null;
    const failedJti = isNonEmptyString(body.failed_context_jti)
      ? body.failed_context_jti
      : null;
    if (ackedJti && failedJti) {
      return jsonError("mutually_exclusive_ack_and_fail", 400);
    }

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
      await commitOnAck(customerId, ackedJti, "baseline_event");
    } else if (failedJti) {
      const reason = isNonEmptyString(body.failure_reason)
        ? body.failure_reason
        : "baseline_event_drain_failed";
      await recordOnFail(customerId, failedJti, reason, "baseline_event");
    }

    // ── Pause gate ───────────────────────────────────────────
    if (!(await isOpportunisticEnabled(customerId, "baseline_event"))) {
      return NextResponse.json(PAUSED_BODY);
    }

    // ── Opportunistic TTL prune ──────────────────────────────
    await pruneExpiredInflight(customerId);

    // ── Queue notices first ──────────────────────────────────
    //
    // Each `next-batch` call returns one logical batch. Drain ordering
    // is "queue notices first, new-row batches second" so window-
    // replace operations (refresh / backfill) land before subsequent
    // new-row INSERTs would advance the cursor past them.
    //
    // We fetch up to `MAX_QUEUE_PEEK + 1` rows so `has_more` reflects
    // whether additional notices remain past the prefix we aggregate
    // this call — the drain loop pulls the next batch on its next
    // iteration.
    const noticeRows = await claimPendingNotices(customerId, "baseline_event", {
      limit: MAX_QUEUE_PEEK + 1,
    });

    if (noticeRows.length > 0) {
      return await emitQueueBatch({
        customerId,
        session,
        noticeRows,
      });
    }

    // ── Streaming slice ──────────────────────────────────────
    const state = await getAimerPushState(customerId, "baseline_event");
    const slice = await loadBaselineStreamingSlice({
      customerId,
      cursorEventTime: state?.last_pushed_event_time ?? null,
      cursorEventKey: state?.last_pushed_event_key ?? null,
    });

    if (slice.events.length === 0 || slice.baselineVersion === null) {
      return NextResponse.json(EMPTY_BODY);
    }

    const tokens = await buildPhase2Push({
      schemaVersion: STREAMING_SCHEMA_VERSION,
      customerId,
      accountId: session.accountId,
      payload: {
        // `external_key` + `source_aice_id` are overwritten by the
        // orchestrator from the customer record + integration setup;
        // pass placeholders to satisfy the schema's non-empty checks.
        external_key: "_",
        source_aice_id: "_",
        baseline_version: slice.baselineVersion,
        events: slice.events,
      },
    });

    await insertInflight(customerId, {
      contextJti: tokens.context_jti,
      kind: "baseline_event",
      cursorAdvanceToEventTime: slice.lastEventTime,
      cursorAdvanceToEventKey: slice.lastEventKey,
      queueRowIds: [],
    });

    const setup = await getAimerIntegrationSetup();
    const aimerEndpointUrl = composeAimerEndpointUrl(
      setup.bridgeUrl,
      STREAMING_AIMER_PATH,
    );

    const responseBody: SuccessBody = {
      has_more: slice.hasMore,
      context_token: tokens.context_token,
      events_envelope: tokens.events_envelope,
      events_data: tokens.events_data,
      context_jti: tokens.context_jti,
      aimer_endpoint_path: STREAMING_AIMER_PATH,
      aimer_endpoint_url: aimerEndpointUrl,
      batch_jti: tokens.context_jti,
      schema_version: STREAMING_SCHEMA_VERSION,
    };
    return NextResponse.json(responseBody);
  },
  {
    requiredPermissions: ["triage:read"],
  },
);

interface EmitQueueBatchInput {
  customerId: number;
  session: { accountId: string };
  noticeRows: AimerPushQueueRow[];
}

async function emitQueueBatch(
  input: EmitQueueBatchInput,
): Promise<NextResponse> {
  const { customerId, session, noticeRows } = input;
  const head = noticeRows[0];
  const queueKind = head.kind as keyof typeof QUEUE_KIND_MAPPING;
  const mapping = QUEUE_KIND_MAPPING[queueKind];
  if (!mapping) {
    // Defensive: `claimPendingNotices` filters by the drain's allowed
    // queue-kind set, so an unmapped kind here would be a programming
    // bug rather than a runtime input issue. Surface as 500 so the
    // caller does not interpret it as work to retry.
    return jsonError("unknown_queue_kind", 500);
  }

  let payload: unknown;
  const claimed: AimerPushQueueRow[] = [head];

  if (queueKind === "withdraw_baseline_event") {
    // Multiple consecutive `withdraw_baseline_event` rows aggregate
    // into a single `phase2.withdraw.v1` envelope (matches the
    // policy-event pattern). Only the prefix of consecutive
    // withdraw rows is taken so a downstream refresh / backfill in
    // the same queue does not delay behind a withdraw aggregation.
    //
    // Aggregation stops when either the row count cap
    // ({@link MAX_QUEUE_PEEK}) or the byte budget
    // ({@link WITHDRAW_PAYLOAD_BYTE_BUDGET}, the shared streaming /
    // refresh cap minus the external_key reserve) would be exceeded —
    // whichever trips first. The drain loop pulls the unclaimed tail on
    // its next iteration.
    const withdrawals: unknown[] = [head.payload];
    for (let i = 1; i < noticeRows.length; i += 1) {
      if (claimed.length >= MAX_QUEUE_PEEK) break;
      const row = noticeRows[i];
      if (row.kind !== "withdraw_baseline_event") break;
      const candidate = withdrawals.concat([row.payload]);
      if (serializeWithdrawals(candidate) > WITHDRAW_PAYLOAD_BYTE_BUDGET) break;
      withdrawals.push(row.payload);
      claimed.push(row);
    }
    payload = { external_key: "_", withdrawals };
  } else {
    // Refresh / backfill carry pre-built sub-window payloads from
    // `payload-builders.ts`. The mutation hook seeds a schema-valid
    // subset (corpus columns only); enrich the inner `events[]` here
    // with the §6 baseline-batch fields so the wire shape is symmetric
    // with the streaming-kind batches (option (a) in the issue's open
    // design call). The orchestrator augments `external_key` at signing
    // time and is unchanged.
    const queued = head.payload as BaselineRefreshSubPayload;
    payload = await enrichRefreshPayload(customerId, queued);
  }

  const tokens = await buildPhase2Push({
    schemaVersion: mapping.schemaVersion,
    customerId,
    accountId: session.accountId,
    payload,
  });

  await insertInflight(customerId, {
    contextJti: tokens.context_jti,
    kind: "baseline_event",
    // Queue notices never advance the streaming cursor — refresh /
    // backfill replace historical windows, withdraw deletes from the
    // far side. The forward cursor is owned by the streaming path.
    cursorAdvanceToEventTime: null,
    cursorAdvanceToEventKey: null,
    queueRowIds: claimed.map((row) => row.id),
  });

  const setup = await getAimerIntegrationSetup();
  const aimerEndpointUrl = composeAimerEndpointUrl(
    setup.bridgeUrl,
    mapping.aimerEndpointPath,
  );

  // `has_more` is true when the queue holds rows past the ones we
  // claimed this call. The drain loop will iterate to pull them.
  const hasMore = noticeRows.length > claimed.length;

  const responseBody: SuccessBody = {
    has_more: hasMore,
    context_token: tokens.context_token,
    events_envelope: tokens.events_envelope,
    events_data: tokens.events_data,
    context_jti: tokens.context_jti,
    aimer_endpoint_path: mapping.aimerEndpointPath,
    aimer_endpoint_url: aimerEndpointUrl,
    batch_jti: tokens.context_jti,
    schema_version: mapping.schemaVersion,
  };
  return NextResponse.json(responseBody);
}
