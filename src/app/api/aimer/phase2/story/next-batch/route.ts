import "server-only";

import { NextResponse } from "next/server";

import {
  buildPhase2Push,
  SYSTEM_ACTOR_ACCOUNT_ID,
} from "@/lib/aimer/phase2/orchestrate";
import type { StoryWireItem } from "@/lib/aimer/phase2/payload-builders";
import {
  type AimerPushQueueRow,
  claimPendingNotices,
  commitOnAck,
  getAimerPushState,
  insertInflight,
  isOpportunisticEnabled,
  type Phase2QueueKind,
  pruneExpiredInflight,
  recordOnFail,
} from "@/lib/aimer/phase2/state";
import {
  loadStoryStragglerSlice,
  loadStoryStreamingSlice,
} from "@/lib/aimer/phase2/story-push";
import type { Phase2SchemaVersion } from "@/lib/aimer/phase2/wire-types";
import { getAimerIntegrationSetup } from "@/lib/aimer/setup-status";
import { auditLog } from "@/lib/audit/logger";
import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import { withAuth } from "@/lib/auth/guard";
import { hasPermission } from "@/lib/auth/permissions";
import { getCustomerPool } from "@/lib/triage/policy/customer-db";

/**
 * `POST /api/aimer/phase2/story/next-batch` (#493).
 *
 * Streaming-kind drain route for the Story queue/cursor per RFC 0002
 * §7. Each call returns one logical batch — either a queue notice
 * (`withdraw_story` / `refresh_story_window` / `backfill_story_window`)
 * OR a new-row Story batch — with `has_more: true` when more pending
 * work remains.
 *
 * Drain order is "queue notices first, new-row batches second", with
 * the three queue kinds claimed in `withdraw → refresh → backfill`
 * priority. The route claims one specific kind at a time via the
 * extended {@link claimPendingNotices} helper so the response
 * always carries exactly one `schema_version` / `aimer_endpoint_path`.
 *
 * NULL-cursor seeding: a brand-new tenant whose
 * `aimer_push_state.last_pushed_event_time IS NULL` does NOT back-
 * flood aimer-web with the entire `event_group` history. The first
 * `next-batch` call with no queue work seeds the cursor to
 * `(NOW(), 0)` and returns empty; subsequent activations push from
 * that point forward only. Pending queue notices are processed
 * regardless of cursor state — the NULL-cursor guard only suppresses
 * the historical new-row stream.
 *
 * β-tracking + audit:
 *
 *  - New-row Story batches: `commitOnAck` (on the next iteration's
 *    `acked_context_jti`) bumps the `event_group` β columns for
 *    every Story in the prior batch and returns their ids; the
 *    route then emits one `triage.story.send` audit row per id
 *    with `trigger: "opportunistic"`,
 *    `actor: SYSTEM_ACTOR_ACCOUNT_ID`. Per-Story emission per #493
 *    "Audit" section.
 *  - Queue notices: NO `triage.story.send` audit. Operational
 *    mutations (refresh / backfill / withdraw) are owned by the
 *    mutation hooks issue (#573), which emits its own audit rows
 *    for the originating user action.
 */

const STORY_STREAMING_SCHEMA_VERSION: Phase2SchemaVersion = "phase2.story.v1";
const STORY_STREAMING_AIMER_PATH = "/api/phase2/story/batch" as const;

const QUEUE_KIND_PRIORITY: readonly Phase2QueueKind[] = [
  "withdraw_story",
  "refresh_story_window",
  "backfill_story_window",
];

interface QueueKindMapping {
  schemaVersion: Phase2SchemaVersion;
  aimerEndpointPath: string;
}

const QUEUE_KIND_MAPPING: Record<
  "withdraw_story" | "refresh_story_window" | "backfill_story_window",
  QueueKindMapping
> = {
  withdraw_story: {
    schemaVersion: "phase2.withdraw.v1",
    aimerEndpointPath: "/api/phase2/withdraw",
  },
  refresh_story_window: {
    schemaVersion: "phase2.refresh_window.v1",
    aimerEndpointPath: "/api/phase2/refresh-window",
  },
  backfill_story_window: {
    schemaVersion: "phase2.backfill.v1",
    aimerEndpointPath: "/api/phase2/backfill",
  },
};

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

/**
 * Seed the `aimer_push_state` cursor for the story kind to
 * `(NOW(), 0)`. Called once on the first `next-batch` activation
 * with no queue work pending and `last_pushed_event_time IS NULL`,
 * so historical `event_group` rows do not back-flood aimer-web on
 * Stories-tab first open. The `0` event_key sentinel is the lower-
 * bound `NUMERIC(39, 0)` value — the first real Story past `NOW()`
 * compares strictly greater regardless of its id.
 *
 * Also stamps `streaming_activated_at = NOW()` so the late-commit
 * straggler scan in `loadStoryStragglerSlice` has a stable floor for
 * the "no historical back-flood on first activation" guarantee. The
 * column is updated atomically with the cursor seed (same UPDATE,
 * same row, same `WHERE last_pushed_event_time IS NULL` predicate)
 * so a stale state row cannot end up with a cursor set but no
 * activation watermark.
 */
async function seedNullCursor(customerId: number): Promise<void> {
  const pool = await getCustomerPool(customerId);
  await pool.query(
    `UPDATE aimer_push_state
        SET last_pushed_event_time   = NOW(),
            last_pushed_event_key    = '0',
            last_synced_at           = NOW(),
            streaming_activated_at   = NOW()
      WHERE kind = 'story'
        AND last_pushed_event_time IS NULL`,
  );
}

async function emitAuditForOpportunisticBatch(
  customerId: number,
  storyBetaRows: readonly { storyId: string; storyVersion: string }[],
): Promise<void> {
  for (const row of storyBetaRows) {
    try {
      await auditLog.record({
        actor: SYSTEM_ACTOR_ACCOUNT_ID,
        action: "triage.story.send",
        target: "triage_story",
        targetId: row.storyId,
        customerId,
        details: {
          customerId,
          storyId: row.storyId,
          storyVersion: row.storyVersion,
          forceRefresh: false,
          // Drain contract does not thread `duplicates_skipped` back
          // to `commitOnAck` — the cross-side `aimer_phase2.ingest`
          // audit on aimer-web carries the precise count. See #493
          // "Audit / Emission unit".
          duplicatesSkipped: null,
          trigger: "opportunistic",
        },
      });
    } catch (err) {
      console.error("triage.story.send audit emission failed", err);
    }
  }
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
      const result = await commitOnAck(customerId, ackedJti, "story");
      if (result.storyBetaRows.length > 0) {
        await emitAuditForOpportunisticBatch(customerId, result.storyBetaRows);
      }
    } else if (failedJti) {
      const reason = isNonEmptyString(body.failure_reason)
        ? body.failure_reason
        : "story_drain_failed";
      await recordOnFail(customerId, failedJti, reason, "story");
    }

    // ── Pause gate ───────────────────────────────────────────
    if (!(await isOpportunisticEnabled(customerId, "story"))) {
      return NextResponse.json(PAUSED_BODY);
    }

    // ── Opportunistic TTL prune ──────────────────────────────
    await pruneExpiredInflight(customerId);

    // ── Queue notices first, one kind per response ───────────
    //
    // The story drain enforces "one queue kind per response" + the
    // `withdraw → refresh → backfill` priority order. Each kind is
    // claimed via the extended `claimPendingNotices(..., { kinds })`
    // option; we stop at the first non-empty result.
    for (const kind of QUEUE_KIND_PRIORITY) {
      const rows = await claimPendingNotices(customerId, "story", {
        limit: 100,
        kinds: [kind],
      });
      if (rows.length === 0) continue;
      return await emitQueueBatch({
        customerId,
        session,
        kind: kind as keyof typeof QUEUE_KIND_MAPPING,
        rows,
      });
    }

    // ── New-row Story batch (cursor-driven) ──────────────────
    const state = await getAimerPushState(customerId, "story");

    // NULL-cursor seeding. Pending queue notices have already been
    // checked above; if we are here the queue is empty. Seed the
    // cursor so the historical event_group stream stays bounded by
    // the activation timestamp (no back-flooding on first open).
    if (state === null || state.last_pushed_event_time === null) {
      await seedNullCursor(customerId);
      return NextResponse.json(EMPTY_BODY);
    }

    // ── Late-commit straggler scan (round-5 follow-up) ───────
    //
    // Catches the race where a correlator transaction commits AFTER a
    // previous drain advanced the cursor past its `created_at` (PG
    // `now()` is transaction-start time, not commit time, so an
    // `event_group` insert can persist a row whose `created_at` is
    // BEHIND the just-advanced cursor and would otherwise be missed
    // forever by the forward `(created_at, id) > cursor` slice).
    //
    // The scan is gated on `streaming_activated_at` so a freshly-
    // seeded tenant does NOT back-flood the entire historical
    // `event_group` corpus on first open. Rows older than activation
    // are pre-existing history; the straggler scan ignores them.
    if (state.streaming_activated_at !== null) {
      const straggler = await loadStoryStragglerSlice({
        customerId,
        cursorEventTime: state.last_pushed_event_time,
        cursorEventKey: state.last_pushed_event_key ?? "0",
        activatedAt: state.streaming_activated_at,
      });
      if (straggler.stories.length > 0) {
        return await emitStreamingBatch({
          customerId,
          session,
          stories: straggler.stories,
          // Stragglers sit AT OR BEHIND the cursor — emitting them
          // must NOT advance the forward cursor (that would either
          // be a no-op via `advanceCursor`'s monotonic guard or, in
          // a degenerate case, double-deliver the next forward
          // slice). β + audit on ack address the `pushed_stories`
          // set persisted on the inflight row.
          cursorAdvanceToEventTime: null,
          cursorAdvanceToEventKey: null,
          // Force has_more=true because there may be more
          // stragglers (or new-row work) past this batch. The drain
          // loop iterates until next-batch returns has_more=false.
          hasMoreOverride: true,
          // Pass the pre-batch cursor as the candidate watermark.
          // `emitStreamingBatch` drops it when
          // `cursorAdvanceToEventTime === null` (this straggler
          // branch), so the wire-level fields are omitted — matching
          // §2's "straggler batches omit the watermark" rule via the
          // helper-level invariant (forward-cursor advance implies
          // watermark attached).
          cursorWatermark: {
            eventTime: state.last_pushed_event_time,
            quality: "soft",
          },
        });
      }
    }

    const slice = await loadStoryStreamingSlice({
      customerId,
      cursorEventTime: state.last_pushed_event_time,
      cursorEventKey: state.last_pushed_event_key,
    });

    if (slice.stories.length === 0) {
      return NextResponse.json(EMPTY_BODY);
    }

    return await emitStreamingBatch({
      customerId,
      session,
      stories: slice.stories,
      // Forward slice: advance the cursor to the last delivered
      // row's `(created_at, id)`. Combined with the persisted
      // `pushed_stories` set, β/audit address the exact signed rows
      // and any Story inserted with `created_at > slice.lastEventTime`
      // is picked up by the next drain (forward case). Rows that
      // commit late with `created_at <= cursor` are caught by the
      // straggler scan above on a subsequent iteration.
      cursorAdvanceToEventTime: slice.lastEventTime,
      cursorAdvanceToEventKey: slice.lastEventKey,
      hasMoreOverride: slice.hasMore,
      // Phase 0.5 (issue #644) — forward streaming carries the
      // pre-batch cursor as a `soft` watermark. Soft because the
      // straggler scan can deliver late-commit rows AT OR BEHIND
      // this timestamp on a subsequent iteration.
      cursorWatermark: {
        eventTime: state.last_pushed_event_time,
        quality: "soft",
      },
    });
  },
  {
    requiredPermissions: ["triage:read"],
  },
);

interface EmitQueueBatchInput {
  customerId: number;
  session: { accountId: string };
  kind: keyof typeof QUEUE_KIND_MAPPING;
  rows: AimerPushQueueRow[];
}

async function emitQueueBatch(
  input: EmitQueueBatchInput,
): Promise<NextResponse> {
  const { customerId, session, kind, rows } = input;
  const mapping = QUEUE_KIND_MAPPING[kind];
  const head = rows[0];

  let payload: unknown;
  let claimed: AimerPushQueueRow[] = [head];

  if (kind === "withdraw_story") {
    // Multiple withdraw_story rows aggregate into a single
    // `phase2.withdraw.v1` envelope to amortize the round-trip cost.
    // The claim already filtered to one kind, so every row in `rows`
    // is a withdraw_story.
    const withdrawals: unknown[] = rows.map((r) => r.payload);
    payload = { external_key: "_", withdrawals };
    claimed = rows.slice();
  } else {
    // refresh_story_window / backfill_story_window carry the pre-
    // built sub-window payload from #573's mutation hook. The
    // orchestrator augments `external_key` at signing time. We do
    // not subdivide on this side — story refresh payloads are
    // already byte-budgeted at enqueue time.
    payload = head.payload;
  }

  let tokens: Awaited<ReturnType<typeof buildPhase2Push>>;
  try {
    tokens = await buildPhase2Push({
      schemaVersion: mapping.schemaVersion,
      customerId,
      accountId: session.accountId,
      payload,
    });
  } catch (err) {
    if (
      err !== null &&
      typeof err === "object" &&
      "code" in err &&
      typeof (err as { code: unknown }).code === "string"
    ) {
      return jsonError((err as { code: string }).code, 409);
    }
    throw err;
  }

  await insertInflight(customerId, {
    contextJti: tokens.context_jti,
    kind: "story",
    // Queue notices never advance the streaming cursor — refresh /
    // backfill replace historical windows, withdraw deletes a row.
    // The forward cursor is owned by the streaming path.
    cursorAdvanceToEventTime: null,
    cursorAdvanceToEventKey: null,
    queueRowIds: claimed.map((row) => row.id),
  });

  const setup = await getAimerIntegrationSetup();
  const aimerEndpointUrl = composeAimerEndpointUrl(
    setup.bridgeUrl,
    mapping.aimerEndpointPath,
  );

  // `has_more` is true because there may be other queue kinds (or
  // new-row streaming work) pending. The drain loop iterates until
  // the next call returns has_more=false.
  const responseBody: SuccessBody = {
    has_more: true,
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

interface EmitStreamingBatchInput {
  customerId: number;
  session: { accountId: string };
  stories: readonly StoryWireItem[];
  /**
   * `(created_at, id)` to advance the cursor to on ack. `null` for the
   * straggler branch — those rows sit AT OR BEHIND the cursor, so the
   * cursor must NOT advance. β/audit on ack address the persisted
   * `pushed_stories` set either way.
   */
  cursorAdvanceToEventTime: Date | null;
  cursorAdvanceToEventKey: string | null;
  /** Response `has_more` value. */
  hasMoreOverride: boolean;
  /**
   * RFC 0002 Phase 0.5 watermark candidate (#644). The helper attaches
   * it to the envelope only when `cursorAdvanceToEventTime !== null`
   * (forward streaming). Callers on the straggler path may still pass
   * the pre-batch cursor here — the helper drops it. This collapses
   * "forward-cursor advance implies watermark attached" to one
   * invariant rather than relying on every call site to remember it.
   *
   * Note: the gate variable (`cursorAdvanceToEventTime`) and the
   * watermark value (`eventTime`) are distinct — `eventTime` MUST be
   * `state.last_pushed_event_time` (pre-batch cursor), NOT
   * `cursorAdvanceToEventTime` (post-batch target).
   */
  cursorWatermark?: {
    eventTime: Date;
    quality: "strict" | "soft";
  };
}

/**
 * Shared envelope-build + inflight-insert + response builder for both
 * streaming branches (forward `(created_at, id) > cursor` slice and
 * the late-commit straggler scan). Centralizes the parts that must
 * stay identical:
 *
 *   - the `phase2.story.v1` schema + endpoint mapping
 *   - the `pushed_stories` projection that drives β/audit on ack
 *   - the structured-error → 409 mapping from `buildPhase2Push`
 *
 * The cursor-advance fields differ per branch and are passed in by
 * the caller.
 */
async function emitStreamingBatch(
  input: EmitStreamingBatchInput,
): Promise<NextResponse> {
  // Phase 0.5 watermark (issue #644): gate per §2 — only forward
  // streaming (cursor advances on ack) attaches the watermark.
  // Straggler batches advance no cursor, so even when the caller
  // passes a `cursorWatermark`, drop it here.
  const watermarkToAttach =
    input.cursorAdvanceToEventTime !== null ? input.cursorWatermark : undefined;

  let tokens: Awaited<ReturnType<typeof buildPhase2Push>>;
  try {
    tokens = await buildPhase2Push({
      schemaVersion: STORY_STREAMING_SCHEMA_VERSION,
      customerId: input.customerId,
      accountId: input.session.accountId,
      payload: {
        external_key: "_",
        source_aice_id: "_",
        stories: input.stories,
      },
      cursorWatermark: watermarkToAttach,
    });
  } catch (err) {
    if (
      err !== null &&
      typeof err === "object" &&
      "code" in err &&
      typeof (err as { code: unknown }).code === "string"
    ) {
      return jsonError((err as { code: string }).code, 409);
    }
    throw err;
  }

  await insertInflight(input.customerId, {
    contextJti: tokens.context_jti,
    kind: "story",
    cursorAdvanceToEventTime: input.cursorAdvanceToEventTime,
    cursorAdvanceToEventKey: input.cursorAdvanceToEventKey,
    queueRowIds: [],
    pushedStories: input.stories.map((s) => ({
      storyId: s.story_id,
      storyVersion: s.story_version,
    })),
  });

  const setup = await getAimerIntegrationSetup();
  const aimerEndpointUrl = composeAimerEndpointUrl(
    setup.bridgeUrl,
    STORY_STREAMING_AIMER_PATH,
  );

  const responseBody: SuccessBody = {
    has_more: input.hasMoreOverride,
    context_token: tokens.context_token,
    events_envelope: tokens.events_envelope,
    events_data: tokens.events_data,
    context_jti: tokens.context_jti,
    aimer_endpoint_path: STORY_STREAMING_AIMER_PATH,
    aimer_endpoint_url: aimerEndpointUrl,
    batch_jti: tokens.context_jti,
    schema_version: STORY_STREAMING_SCHEMA_VERSION,
  };
  return NextResponse.json(responseBody);
}
