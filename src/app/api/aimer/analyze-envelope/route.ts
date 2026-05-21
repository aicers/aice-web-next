import "server-only";

import { NextResponse } from "next/server";

import {
  ANALYZE_EVENT_KEY_PATTERN,
  type AnalyzeLang,
  eventsEnvelopeHash,
  eventToSnakeCase,
  sha256Base64Url,
  signAnalyzeParamsToken,
} from "@/lib/aimer/analyze-envelope";
import {
  AIMER_CONTEXT_TOKEN_AUDIENCE,
  generateContextTokenJti,
  signContextToken,
} from "@/lib/aimer/context-token";
import { signEventsEnvelope } from "@/lib/aimer/events-envelope";
import { loadSingleBaselineEventWireItem } from "@/lib/aimer/phase2/baseline-push";
import { getAimerIntegrationSetup } from "@/lib/aimer/setup-status";
import { loadActiveSigningKeyMaterial } from "@/lib/aimer/signing-key";
import { auditLog } from "@/lib/audit/logger";
import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import type { AuthSession } from "@/lib/auth/jwt";
import { hasPermission } from "@/lib/auth/permissions";
import { query } from "@/lib/db/client";
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
 * `POST /api/aimer/analyze-envelope`
 *
 * Mints the four-field signed-multipart envelope the Detection menu
 * Send button submits as a top-level form POST to aimer-web's
 * `/api/analysis/analyze-bridge` endpoint (#629). The route is the
 * single aice-web-next-side authority for the analyze-bridge
 * envelope; the browser never speaks to aimer-web directly for
 * signing.
 *
 * Returns:
 *
 *   {
 *     contextToken: string,         // JWS, jti + iat/exp/aud/iss
 *     eventsEnvelope: string,       // JWS, payload_hash + context_jti
 *     eventsData: string,           // UTF-8 JSON bytes
 *     analyzeParamsToken: string,   // JWS, cross-binds the other three
 *     targetUrl: string,            // <aimer-web>/api/analysis/analyze-bridge
 *   }
 *
 * Per call:
 *
 *   1. Tenant-scope check on `customerId` (same gate as the Phase 1
 *      context-token route — `detection:read` users for tenant A
 *      must not mint envelopes for tenant B).
 *   2. Setup gating: `aice_id`, `aimer_web_bridge_url`,
 *      `aimer_default_model_name`, `aimer_default_model`, and an
 *      active signing key must all be present.
 *   3. Resolve the customer's `external_key`.
 *   4. REview event-resolution gate (`event(id:)` under
 *      `customerIds: [customerId]`) — same security property as the
 *      Phase 1 / Phase 2 routes.
 *   5. Decide `event_data` source:
 *        - Baseline-passing row → reuse
 *          {@link loadSingleBaselineEventWireItem} and strip the
 *          four Phase 2 enrichment fields (`window_signals`,
 *          `score_window_context`, `asset_context`,
 *          `scoring_weights_snapshot`).
 *        - Otherwise → use the REview event payload converted to
 *          snake_case canonical form (with `__typename` mapped to
 *          `kind`).
 *   6. Mint `context_token` (`jti = uuidv4()`), serialize
 *      `event_data` bytes, mint `events_envelope`
 *      (`schema_version = "analyze-bridge.v1"`,
 *      `event_count = 1`), compute the envelope-hash and mint
 *      `analyze_params_token` with the 9 documented claims.
 *
 * `force` defaults to `false`; the click handler sets it `true`
 * when the operator arrives via aimer-web's `?aimerForce=1`
 * round-trip link.
 *
 * Rate limiting reuses the shared bridge bucket so analyze-envelope
 * traffic counts against the same per-(account, IP) quota the
 * legacy Phase 1 context-token route used.
 *
 * Audit emissions: `aimer_analyze_envelope.issued` on success,
 * `aimer_analyze_envelope.denied` on every pre-mint guard failure.
 */

const ANALYZE_BRIDGE_PATH = "/api/analysis/analyze-bridge";
const ANALYZE_BRIDGE_SCHEMA_VERSION = "analyze-bridge.v1" as const;
const CONTEXT_TOKEN_TTL_SECONDS = 60;

const PHASE2_ENRICHMENT_KEYS = [
  "window_signals",
  "score_window_context",
  "asset_context",
  "scoring_weights_snapshot",
] as const;

interface RequestBody {
  locator?: unknown;
  customerId?: unknown;
  lang?: unknown;
  force?: unknown;
}

interface EventByIdVariables extends Record<string, unknown> {
  id: string;
}

type DenialReason =
  | "rate_limited"
  | "not_found"
  | "invalid_locator"
  | "invalid_event_key"
  | "invalid_lang"
  | "aimer_integration_not_configured"
  | "customer_external_key_missing"
  | "event_not_found_for_customer"
  | "customer_not_found";

function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

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

function parseLang(input: unknown): AnalyzeLang | null {
  if (input === "ENGLISH" || input === "KOREAN") return input;
  return null;
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
    action: "aimer_analyze_envelope.denied",
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

    const lang = parseLang(body.lang);
    if (lang === null) {
      await recordDenial({
        session,
        ip,
        reason: "invalid_lang",
        requestedCustomerId: customerId,
      });
      return jsonError("invalid_lang", 400);
    }

    const force = body.force === true;

    // Tenant scope: cross-tenant mints are masked as a generic 404
    // to avoid leaking customer existence — same shape the legacy
    // routes used.
    const isAdmin = await hasPermission(session.roles, "customers:access-all");
    if (!isAdmin) {
      const ids = await resolveEffectiveCustomerIds(
        session.accountId,
        session.roles,
      );
      if (!ids.includes(customerId)) {
        await recordDenial({ session, ip, reason: "not_found" });
        return jsonError("not_found", 404);
      }
    }

    // Setup gating — all five prerequisites must be present so the
    // signed envelope is structurally complete. A missing
    // `aimer_default_model_name` / `aimer_default_model` is a 503
    // because aimer-web#254 made both required.
    const setup = await getAimerIntegrationSetup();
    if (
      !setup.aiceId ||
      !setup.bridgeUrl ||
      !setup.defaultModelName ||
      !setup.defaultModel ||
      !setup.hasActiveSigningKey
    ) {
      await recordDenial({
        session,
        ip,
        reason: "aimer_integration_not_configured",
        requestedCustomerId: customerId,
      });
      return jsonError("aimer_integration_not_configured", 503);
    }

    // Customer record + external_key — analyze-bridge accepts only
    // `external_key` for cross-site callers (the internal UUID path
    // is reserved for same-origin callers on the JSON endpoint).
    const { rows } = await query<{ id: number; external_key: string | null }>(
      "SELECT id, external_key FROM customers WHERE id = $1",
      [customerId],
    );
    if (rows.length === 0) {
      await recordDenial({
        session,
        ip,
        reason: "event_not_found_for_customer",
        requestedCustomerId: customerId,
      });
      return jsonError("event_not_found_for_customer", 404);
    }
    const externalKey = rows[0].external_key?.trim() ?? "";
    if (externalKey.length === 0) {
      await recordDenial({
        session,
        ip,
        reason: "customer_external_key_missing",
        requestedCustomerId: customerId,
      });
      return jsonError("customer_external_key_missing", 400);
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

    if (!ANALYZE_EVENT_KEY_PATTERN.test(locator.id)) {
      await recordDenial({
        session,
        ip,
        reason: "invalid_event_key",
        requestedCustomerId: customerId,
      });
      return jsonError("invalid_event_key", 400);
    }

    // REview scope check (#439 / #621 central security property).
    let eventDetail: EventDetailResult;
    try {
      // biome-ignore format: keep the override on the helper-name line so
      // scripts/check-dispatch-context.mjs sees `// scope-allowlist:` within
      // the call expression range (helper-name → opening paren).
      eventDetail = (await withManagerErrorMapping(graphqlRequest( // scope-allowlist: #629 analyze-envelope single-customer mint
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

    // Source-branch `event_data`: baseline row → stripped wire item;
    // otherwise → snake-cased REview payload.
    const baselineWireItem = await loadSingleBaselineEventWireItem({
      customerId,
      eventKey: locator.id,
    });
    let eventData: Record<string, unknown>;
    if (baselineWireItem !== null) {
      const stripped: Record<string, unknown> = { ...baselineWireItem };
      for (const k of PHASE2_ENRICHMENT_KEYS) delete stripped[k];
      eventData = stripped;
    } else {
      eventData = eventToSnakeCase(
        eventDetail.event as unknown as Record<string, unknown>,
      );
      // Anchor `event_key` to the locator so the top-level claim and
      // the embedded value agree — aimer-web's `event_key_mismatch`
      // guard rejects any drift.
      eventData.event_key = locator.id;
    }

    // Serialize and hash event_data → multipart bytes.
    const eventsDataJson = JSON.stringify(eventData);
    const eventsData = new TextEncoder().encode(eventsDataJson);

    const keyMaterial = loadActiveSigningKeyMaterial();
    if (!keyMaterial) {
      await recordDenial({
        session,
        ip,
        reason: "aimer_integration_not_configured",
        requestedCustomerId: customerId,
      });
      return jsonError("aimer_integration_not_configured", 503);
    }

    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + CONTEXT_TOKEN_TTL_SECONDS;
    const jti = generateContextTokenJti();
    const customerIds = [externalKey];

    const contextTokenJws = await signContextToken({
      iss: setup.aiceId,
      aud: AIMER_CONTEXT_TOKEN_AUDIENCE,
      sub: session.accountId,
      aice_id: setup.aiceId,
      customer_ids: customerIds,
      iat,
      exp,
      jti,
    });

    const eventsEnvelopeJws = await signEventsEnvelope(
      {
        iss: setup.aiceId,
        aice_id: setup.aiceId,
        customer_ids: customerIds,
        schema_version: ANALYZE_BRIDGE_SCHEMA_VERSION,
        event_count: 1,
        iat,
        exp,
        context_jti: jti,
      },
      eventsData,
    );

    const payloadHash = sha256Base64Url(eventsData);
    const envelopeHash = eventsEnvelopeHash(eventsEnvelopeJws);

    const analyzeParamsTokenJws = await signAnalyzeParamsToken(
      {
        context_jti: jti,
        payload_hash: payloadHash,
        envelope_hash: envelopeHash,
        event_key: locator.id,
        lang,
        model_name: setup.defaultModelName,
        model: setup.defaultModel,
        force,
        external_key: externalKey,
      },
      { iss: setup.aiceId, iat, exp },
    );

    await auditLog.record({
      actor: session.accountId,
      action: "aimer_analyze_envelope.issued",
      target: "customer",
      targetId: String(customerId),
      customerId,
      details: {
        customerId,
        jti,
        eventKey: locator.id,
        lang,
        force,
        kid: keyMaterial.kid,
        baselineSource: baselineWireItem !== null,
      },
      ip,
      sid: session.sessionId,
    });

    return NextResponse.json({
      contextToken: contextTokenJws,
      eventsEnvelope: eventsEnvelopeJws,
      eventsData: eventsDataJson,
      analyzeParamsToken: analyzeParamsTokenJws,
      targetUrl: `${setup.bridgeUrl}${ANALYZE_BRIDGE_PATH}`,
    });
  },
  {
    requiredPermissions: ["detection:read"],
    skipApiRateLimit: true,
  },
);
