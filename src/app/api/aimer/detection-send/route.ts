import "server-only";

import { NextResponse } from "next/server";

import {
  type BaselineStreamingEvent,
  loadSingleBaselineEventWireItem,
} from "@/lib/aimer/phase2/baseline-push";
import { buildPhase2Push } from "@/lib/aimer/phase2/orchestrate";
import type { Phase2SchemaVersion } from "@/lib/aimer/phase2/wire-types";
import { getAimerIntegrationSetup } from "@/lib/aimer/setup-status";
import { auditLog } from "@/lib/audit/logger";
import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import type { AuthSession } from "@/lib/auth/jwt";
import { hasPermission } from "@/lib/auth/permissions";
import { EVENT_BY_ID_QUERY } from "@/lib/detection/queries";
import type { EventDetailResult } from "@/lib/detection/types";
import {
  decodeEventLocator,
  type EventLocator,
} from "@/lib/events/event-locator";
import { graphqlRequest } from "@/lib/graphql/client";
import { withManagerErrorMapping } from "@/lib/node/error-mapping";
import { checkAimerContextTokenRateLimit } from "@/lib/rate-limit/limiter";
import { ReviewForbiddenError } from "@/lib/review/errors";

/**
 * `POST /api/aimer/detection-send`
 *
 * Detection menu Send button routing per RFC 0002 §8 Storage routing
 * and sub-issue #621. Splits the operator's Send click between Phase 1
 * (existing bridge handoff to `detection_events` via
 * `/api/aimer/context-token`) and Phase 2 (single-event baseline batch
 * to `https://<aimer-web>/api/phase2/baseline/batch`) based on whether
 * the event is currently baseline-passing.
 *
 * Per call:
 *
 *   1. Tenant scope check on `customerId` (same gate as the Phase 1
 *      context-token route — `detection:read` users for tenant A must
 *      not be able to mint envelopes for tenant B).
 *   2. REview event-resolution gate: `event(id:)` under
 *      `{ role, customerIds: [customerId] }`. This mirrors the Phase 1
 *      context-token route's central security property (#439) — proving
 *      the caller's session can currently *read* the event in REview
 *      before any envelope can be minted. A `null` result or a
 *      `ReviewForbiddenError` masks as the same 404
 *      `event_not_found_for_customer` shape the Phase 1 route returns,
 *      so corpus / scope misses are indistinguishable on the wire.
 *   3. Existence probe: `SELECT 1 FROM baseline_triaged_event WHERE
 *      event_key = $1 LIMIT 1` against the customer DB.
 *   4a. Row not found → `{ route: "phase1" }`. The client falls back
 *       to the existing `POST /api/aimer/context-token` + multipart
 *       form-navigation flow per #441.
 *   4b. Row found → load the single event via
 *       {@link loadSingleBaselineEventWireItem}, build the
 *       `phase2.baseline.v1` envelope via {@link buildPhase2Push},
 *       return `{ route: "phase2", ...tokens, aimer_endpoint_url }`.
 *       The browser POSTs the multipart body directly to aimer-web;
 *       on 2xx ack it renders the "Sent via Phase 2 (Triage analysis)"
 *       toast.
 *
 * Cursor advancement (RFC 0002 §8 "Race vs cursor"): the single-event
 * Phase 2 push does NOT advance `aimer_push_state.last_pushed_event_*`.
 * A subsequent opportunistic streaming sweep past the same `event_key`
 * is absorbed by aimer-web's idempotent `(baseline_version, event_key)`
 * check (`duplicates_skipped`). This route therefore writes no rows in
 * `aimer_push_state` / `aimer_push_inflight` / `aimer_push_queue`.
 *
 * Pause toggle bypass (RFC 0002 §8): manual Send is a per-item
 * operator action and bypasses the opportunistic pause toggle —
 * `next-batch`'s pause check does not apply here.
 *
 * Permission gate is `detection:read` to mirror the Phase 1 context-
 * token route — the routing decision must not change the trust surface
 * relative to the existing Send flow.
 *
 * Rate limiting reuses the bridge-specific bucket
 * ({@link checkAimerContextTokenRateLimit}, 30/60s per (account, IP))
 * so this route and `/api/aimer/context-token` share one quota.
 * Phase 1 clicks therefore consume two slots per Send (one on routing,
 * one on the downstream context-token call) — acceptable within the
 * bridge bucket's headroom and preferable to a per-route bucket that
 * would double the abuse-attack surface.
 *
 * Audit emissions (`aimer_detection_send.issued` /
 * `aimer_detection_send.denied`) mirror the existing
 * `aimer_context_token.{issued,denied}` shape. `.issued` fires only
 * on the Phase 2 path — Phase 1 routing produces no envelope here and
 * the downstream `/api/aimer/context-token` emits its own `.issued`.
 * `.denied` fires for every guard / orchestration failure so the audit
 * trail captures denials before either downstream emitter would run.
 */

interface RequestBody {
  locator?: unknown;
  customerId?: unknown;
}

const PHASE2_SCHEMA_VERSION: Phase2SchemaVersion = "phase2.baseline.v1";
const PHASE2_AIMER_PATH = "/api/phase2/baseline/batch" as const;

interface Phase1Response {
  route: "phase1";
}

interface Phase2Response {
  route: "phase2";
  context_token: string;
  events_envelope: string;
  events_data: string;
  context_jti: string;
  aimer_endpoint_path: typeof PHASE2_AIMER_PATH;
  aimer_endpoint_url: string;
  schema_version: typeof PHASE2_SCHEMA_VERSION;
}

const PHASE1_BODY: Phase1Response = { route: "phase1" };

/**
 * Reuse the Phase 1 route's locator validator so the surface and the
 * in-app `/events/<token>` route share one validation rule. Encodes the
 * input object to a base64url token and round-trips it through
 * `decodeEventLocator`.
 */
function validateLocator(input: unknown): EventLocator | null {
  if (!input || typeof input !== "object") return null;
  let json: string;
  try {
    json = JSON.stringify(input);
  } catch {
    return null;
  }
  const token = Buffer.from(json, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return decodeEventLocator(token);
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

type DenialReason =
  | "rate_limited"
  | "not_found"
  | "event_not_found_for_customer"
  | "invalid_locator"
  | "aimer_integration_not_configured"
  | "customer_external_key_missing"
  | "customer_not_found";

interface EventByIdVariables extends Record<string, unknown> {
  id: string;
}

async function recordDenial(params: {
  session: AuthSession;
  ip: string;
  reason: DenialReason;
  requestedCustomerId?: number;
}): Promise<void> {
  const details: Record<string, unknown> = { reason: params.reason };
  if (typeof params.requestedCustomerId === "number") {
    details.requestedCustomerId = params.requestedCustomerId;
  }
  await auditLog.record({
    actor: params.session.accountId,
    action: "aimer_detection_send.denied",
    target: "customer",
    targetId:
      typeof params.requestedCustomerId === "number"
        ? String(params.requestedCustomerId)
        : undefined,
    details,
    ip: params.ip,
    sid: params.session.sessionId,
  });
}

export const POST = withAuth(
  async (request, _context, session) => {
    const ip = extractClientIp(request);

    // Shared bridge-specific bucket (30 / 60s per account-IP). Counts
    // against the same quota as `/api/aimer/context-token` so a hostile
    // client cannot route around the cap by alternating the two
    // endpoints — Phase 1 clicks consume two slots per Send, which the
    // bucket has headroom for.
    const rl = await checkAimerContextTokenRateLimit(session.accountId, ip);
    if (rl.limited) {
      await recordDenial({ session, ip, reason: "rate_limited" });
      return NextResponse.json(
        { error: "rate_limited" },
        {
          status: 429,
          headers: { "Retry-After": String(rl.retryAfterSeconds) },
        },
      );
    }

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

    // Tenant scope: a `detection:read` user for tenant A must not be
    // able to mint a Phase 2 envelope for tenant B even if they
    // construct the request directly. Admins (`customers:access-all`)
    // skip. 404 mirrors the Phase 1 route — existence is never leaked
    // through a divergent status code.
    const isAdmin = await hasPermission(session.roles, "customers:access-all");
    if (!isAdmin) {
      const ids = await resolveEffectiveCustomerIds(
        session.accountId,
        session.roles,
      );
      if (!ids.includes(customerId)) {
        // Denial audit is intentionally customer-agnostic (no
        // `requestedCustomerId` in details) so the row cannot be used
        // to enumerate tenant membership from the audit log itself —
        // mirrors the `aimer_context_token.denied` policy decision.
        await recordDenial({ session, ip, reason: "not_found" });
        return jsonError("not_found", 404);
      }
    }

    const locator = validateLocator(body.locator);
    if (!locator) {
      await recordDenial({
        session,
        ip,
        reason: "invalid_locator",
        requestedCustomerId: customerId,
      });
      return jsonError("invalid_locator", 400);
    }

    // REview event-resolution gate (the central security property
    // shared with the Phase 1 context-token route, #439). Dispatch
    // with `customerIds: [customerId]` regardless of the caller's full
    // effective scope so a multi-customer user cannot mint a Phase 2
    // envelope bound to customer A for an event that lives under
    // customer B. Without this check, a `detection:read` caller for
    // tenant A could pick any numeric `locator.id` that happens to
    // exist in tenant A's `baseline_triaged_event` corpus and receive
    // Phase 2 tokens — bypassing the per-session readability gate that
    // the Phase 1 path enforces via the same query.
    //
    // Runs BEFORE the corpus probe so a baseline-passing row that the
    // session has no readability claim to does not leak through
    // response timing (`event_not_found_for_customer` is the same
    // 404 shape whether the row exists in the corpus or not).
    //
    // Error policy mirrors the Phase 1 route:
    //   - `ReviewForbiddenError` → mask as 404 so existence is not
    //     leaked through a divergent status code.
    //   - `event === null` → same 404.
    //   - Other failures (transport drops, missing endpoint, mTLS
    //     handshake, `ReviewInvalidArgumentError`,
    //     `ReviewUnknownGraphQLError`, …) propagate as a real 5xx.
    let eventDetail: EventDetailResult;
    try {
      // biome-ignore format: keep the override on the helper-name line so
      // scripts/check-dispatch-context.mjs sees `// scope-allowlist:` within
      // the call expression range (helper-name → opening paren).
      eventDetail = (await withManagerErrorMapping(graphqlRequest( // scope-allowlist: #621 single-customer event-resolution gate
        EVENT_BY_ID_QUERY,
        { id: locator.id } as EventByIdVariables,
        { role: session.roles[0] ?? "", customerIds: [customerId] },
      ))) as EventDetailResult;
    } catch (err) {
      if (err instanceof ReviewForbiddenError) {
        await recordDenial({
          session,
          ip,
          reason: "event_not_found_for_customer",
          requestedCustomerId: customerId,
        });
        return jsonError("event_not_found_for_customer", 404);
      }
      throw err;
    }
    if (eventDetail.event === null) {
      await recordDenial({
        session,
        ip,
        reason: "event_not_found_for_customer",
        requestedCustomerId: customerId,
      });
      return jsonError("event_not_found_for_customer", 404);
    }

    // REview's `Event.id` is documented as opaque, but in practice it
    // is the decimal i128 cursor that maps 1:1 to
    // `baseline_triaged_event.event_key`. {@link
    // loadSingleBaselineEventWireItem} pattern-checks the id before
    // issuing the SQL, so a non-numeric input safely returns null and
    // the client falls through to Phase 1 — same outcome as a row that
    // simply does not exist in the corpus. A DB error on the existence
    // probe propagates as a 500 so the client surfaces an error toast
    // rather than silently routing to Phase 1 (which would render a
    // misleading "Phase 1 sent" disclosure).
    const wireItem: BaselineStreamingEvent | null =
      await loadSingleBaselineEventWireItem({
        customerId,
        eventKey: locator.id,
      });

    if (wireItem === null) {
      const phase1Body: Phase1Response = PHASE1_BODY;
      return NextResponse.json(phase1Body);
    }

    // Baseline-passing → build the single-event Phase 2 envelope.
    // `external_key` + `source_aice_id` are placeholders here; the
    // orchestrator overwrites both from the resolved customer record +
    // integration setup before signing.
    let tokens: Awaited<ReturnType<typeof buildPhase2Push>>;
    try {
      tokens = await buildPhase2Push({
        schemaVersion: PHASE2_SCHEMA_VERSION,
        customerId,
        accountId: session.accountId,
        payload: {
          external_key: "_",
          source_aice_id: "_",
          baseline_version: wireItem.baseline_version,
          events: [wireItem],
        },
      });
    } catch (err) {
      // Surface the structured code (`aimer_integration_not_configured`
      // / `customer_external_key_missing` / `customer_not_found`) so
      // the client can map to a precise toast — mirrors the policy-run
      // build-envelope route's error-passthrough shape.
      if (
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        typeof (err as { code: unknown }).code === "string"
      ) {
        const code = (err as { code: string }).code;
        const status = code === "aimer_integration_not_configured" ? 503 : 409;
        await recordDenial({
          session,
          ip,
          reason: code as DenialReason,
          requestedCustomerId: customerId,
        });
        return jsonError(code, status);
      }
      throw err;
    }

    const setup = await getAimerIntegrationSetup();
    const aimerEndpointUrl = composeAimerEndpointUrl(
      setup.bridgeUrl,
      PHASE2_AIMER_PATH,
    );
    if (!aimerEndpointUrl) {
      // The orchestrator's setup gate already rejects a missing bridge
      // URL with `aimer_integration_not_configured`, so reaching here
      // would mean the bridge URL was unset between the two reads.
      // Surface the same structured code rather than returning a half-
      // populated response.
      await recordDenial({
        session,
        ip,
        reason: "aimer_integration_not_configured",
        requestedCustomerId: customerId,
      });
      return jsonError("aimer_integration_not_configured", 503);
    }

    await auditLog.record({
      actor: session.accountId,
      action: "aimer_detection_send.issued",
      target: "customer",
      targetId: String(customerId),
      customerId,
      details: {
        customerId,
        jti: tokens.context_jti,
        eventKey: wireItem.event_key,
        baselineVersion: wireItem.baseline_version,
        schemaVersion: PHASE2_SCHEMA_VERSION,
      },
      ip,
      sid: session.sessionId,
    });

    const phase2Body: Phase2Response = {
      route: "phase2",
      context_token: tokens.context_token,
      events_envelope: tokens.events_envelope,
      events_data: tokens.events_data,
      context_jti: tokens.context_jti,
      aimer_endpoint_path: PHASE2_AIMER_PATH,
      aimer_endpoint_url: aimerEndpointUrl,
      schema_version: PHASE2_SCHEMA_VERSION,
    };
    return NextResponse.json(phase2Body);
  },
  {
    requiredPermissions: ["detection:read"],
    // Skip the generic per-user API bucket — this route enforces its
    // own bridge-specific bucket (shared with `/api/aimer/context-token`)
    // so bridge usage and generic API traffic do not starve each other.
    skipApiRateLimit: true,
  },
);
