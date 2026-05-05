import "server-only";

import { NextResponse } from "next/server";

import {
  AIMER_CONTEXT_TOKEN_AUDIENCE,
  generateContextTokenJti,
  signContextToken,
} from "@/lib/aimer/context-token";
import {
  buildStubEventsData,
  signEventsEnvelope,
} from "@/lib/aimer/events-envelope";
import { getAimerIntegrationSetup } from "@/lib/aimer/setup-status";
import { loadActiveSigningKeyMaterial } from "@/lib/aimer/signing-key";
import { auditLog } from "@/lib/audit/logger";
import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import type { AuthSession } from "@/lib/auth/jwt";
import { hasPermission } from "@/lib/auth/permissions";
import { query } from "@/lib/db/client";
import { EVENT_DETAIL_QUERY } from "@/lib/detection/queries";
import { locatorToEventListFilter } from "@/lib/detection/server-actions";
import type {
  EventDetailResult,
  EventListFilterInput,
} from "@/lib/detection/types";
import {
  decodeEventLocator,
  type EventLocator,
} from "@/lib/events/event-locator";
import { graphqlRequest } from "@/lib/graphql/client";
import { withManagerErrorMapping } from "@/lib/node/error-mapping";
import { checkAimerContextTokenRateLimit } from "@/lib/rate-limit/limiter";
import { ReviewForbiddenError } from "@/lib/review/errors";

// ── Constants ────────────────────────────────────────────────────

/** Code path on the bridge target where the multipart POST lands. */
const BRIDGE_PATH = "/api/auth/bridge";

/** Stub schema_version for the first cycle (see #439). */
const STUB_SCHEMA_VERSION = "0.0-stub";
/** Stub event_count for the first cycle (see #439). */
const STUB_EVENT_COUNT = 1;

/** Context-token TTL in seconds (within patio#556 §6.6's 30s–2min band). */
const CONTEXT_TOKEN_TTL_SECONDS = 60;

// ── Denial reasons ──────────────────────────────────────────────

type DenialReason =
  | "aimer_integration_not_configured"
  | "customer_external_key_missing"
  | "event_not_found_for_customer"
  | "rate_limited";

interface EventDetailVariables extends Record<string, unknown> {
  filter: EventListFilterInput;
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Validate a request-body locator object by round-tripping it through
 * the canonical {@link decodeEventLocator}.  Reuses the strict
 * type/range/curated-kind checks that the encoded-token decoder
 * already performs, so the API surface and the in-app `/events/:token`
 * route share one validation rule.
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
    action: "aimer_context_token.denied",
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

function denyEventNotFound(): NextResponse {
  return NextResponse.json(
    { error: "event_not_found_for_customer" },
    { status: 404 },
  );
}

// ── Handler ─────────────────────────────────────────────────────

/**
 * `POST /api/aimer/context-token`
 *
 * Issues a short-lived ES256-signed context token plus a stub events
 * envelope so the Send to Aimer button can multipart-POST the result
 * to aimer-web's bridge.  See the issue (#439) for the full security
 * model — single-customer dispatch is the central regression
 * property.
 */
export const POST = withAuth(
  async (request, _context, session) => {
    const ip = extractClientIp(request);

    // ── Bridge-specific rate limit ─────────────────────────────
    //
    // Counts independently from the global authenticated-API
    // limiter (different bucket key on the same fixed-window
    // store), so a flurry of bridge usage does not starve the
    // user's other API traffic, and vice versa.
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

    // ── Parse + validate body (customerId only) ────────────────
    //
    // Locator validation is deliberately deferred until after the
    // customer access gate.  Validating the locator first would
    // surface `400 invalid_locator` for callers who lack access to
    // the requested customerId, which leaks "your locator was
    // malformed" vs "the masked 404" — the issue's information-
    // disclosure ordering forbids that.
    let body: { locator?: unknown; customerId?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }
    if (
      typeof body.customerId !== "number" ||
      !Number.isInteger(body.customerId) ||
      body.customerId <= 0
    ) {
      return NextResponse.json(
        { error: "invalid_customer_id" },
        { status: 400 },
      );
    }
    const customerId = body.customerId;

    // ── Setup gating (Sub-7.2.AB) ──────────────────────────────
    //
    // Read the full-value variant — this route is server-side, so
    // reading the actual `aiceId` / `bridgeUrl` is fine.  The
    // minimum-disclosure rule (#440) governs only what crosses to
    // the client.
    const setup = await getAimerIntegrationSetup();
    if (!setup.aiceId || !setup.bridgeUrl || !setup.hasActiveSigningKey) {
      await recordDenial({
        session,
        ip,
        reason: "aimer_integration_not_configured",
        requestedCustomerId: customerId,
      });
      return NextResponse.json(
        { error: "aimer_integration_not_configured" },
        { status: 503 },
      );
    }

    // ── Customer access check (404-masked) ─────────────────────
    //
    // 403 would leak existence of a customer the caller cannot
    // access; #439 deliberately collapses that into the same 404
    // shape used by locator-mismatch failures.  The forensic
    // analyst can still distinguish access-denied from genuine
    // miss via the cross-correlated detection-side audit trail.
    const isAdmin = await hasPermission(session.roles, "customers:access-all");
    if (!isAdmin) {
      const ids = await resolveEffectiveCustomerIds(
        session.accountId,
        session.roles,
      );
      if (!ids.includes(customerId)) {
        await recordDenial({
          session,
          ip,
          reason: "event_not_found_for_customer",
          requestedCustomerId: customerId,
        });
        return denyEventNotFound();
      }
    }

    // ── Resolve the customer record + external_key ─────────────
    const { rows } = await query<{ id: number; external_key: string | null }>(
      "SELECT id, external_key FROM customers WHERE id = $1",
      [customerId],
    );
    if (rows.length === 0) {
      // Customer doesn't exist (only reachable for access-all
      // callers, since the per-account scope above already covers
      // the rest).  Mask as the same 404 shape so existence is
      // never leaked through a divergent status code.
      await recordDenial({
        session,
        ip,
        reason: "event_not_found_for_customer",
        requestedCustomerId: customerId,
      });
      return denyEventNotFound();
    }
    const externalKey = rows[0].external_key?.trim() ?? "";
    if (externalKey.length === 0) {
      await recordDenial({
        session,
        ip,
        reason: "customer_external_key_missing",
        requestedCustomerId: customerId,
      });
      return NextResponse.json(
        { error: "customer_external_key_missing" },
        { status: 400 },
      );
    }

    // ── Locator validation (after access + external_key gates) ─
    //
    // Deferred to here so callers without access to `customerId`
    // see the masked 404 regardless of locator shape — see the
    // ordering note at the top of the handler.
    const locator = validateLocator(body.locator);
    if (!locator) {
      return NextResponse.json({ error: "invalid_locator" }, { status: 400 });
    }

    // ── Locator resolution under single-customer scope ─────────
    //
    // The central security property of this route: dispatch with
    // `customerIds: [customerId]` regardless of the caller's full
    // effective scope, so a multi-customer user cannot mint a
    // token bound to customer A for an event that lives under
    // customer B.  Bypasses `buildDispatchContext` on purpose.
    //
    // Error policy:
    //   - `ReviewForbiddenError` (review-side denial) — mask as the
    //     same 404 used for the access gate so existence is not
    //     leaked through a divergent status code.
    //   - Everything else (transport drops, missing endpoint, mTLS
    //     handshake, `ReviewInvalidArgumentError`,
    //     `ReviewUnknownGraphQLError`, …) propagates as a real
    //     5xx — these are operational / contract failures, not a
    //     customer/event miss, and auditing them as the latter
    //     would defeat the security guardrails of #405.
    const filter = locatorToEventListFilter(locator);
    let detail: EventDetailResult;
    try {
      // biome-ignore format: keep the override on the helper-name line so
      // scripts/check-dispatch-context.mjs sees `// scope-allowlist:` within
      // the call expression range (helper-name → opening paren).
      detail = (await withManagerErrorMapping(graphqlRequest( // scope-allowlist: #439 single-customer
        EVENT_DETAIL_QUERY,
        { filter } as EventDetailVariables,
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
        return denyEventNotFound();
      }
      throw err;
    }
    if (detail.eventList.nodes.length === 0) {
      await recordDenial({
        session,
        ip,
        reason: "event_not_found_for_customer",
        requestedCustomerId: customerId,
      });
      return denyEventNotFound();
    }

    // ── Sign tokens ────────────────────────────────────────────
    const keyMaterial = loadActiveSigningKeyMaterial();
    if (!keyMaterial) {
      // Defense in depth: the setup gate above already ruled this
      // out, but a key file removed mid-request would land here.
      await recordDenial({
        session,
        ip,
        reason: "aimer_integration_not_configured",
        requestedCustomerId: customerId,
      });
      return NextResponse.json(
        { error: "aimer_integration_not_configured" },
        { status: 503 },
      );
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

    const eventsData = buildStubEventsData();
    const eventsEnvelopeJws = await signEventsEnvelope(
      {
        iss: setup.aiceId,
        aice_id: setup.aiceId,
        customer_ids: customerIds,
        schema_version: STUB_SCHEMA_VERSION,
        event_count: STUB_EVENT_COUNT,
        iat,
        exp,
        context_jti: jti,
      },
      eventsData,
    );

    await auditLog.record({
      actor: session.accountId,
      action: "aimer_context_token.issued",
      target: "customer",
      targetId: String(customerId),
      customerId,
      details: { customerId, jti, kid: keyMaterial.kid },
      ip,
      sid: session.sessionId,
    });

    return NextResponse.json({
      contextTokenJws,
      eventsEnvelopeJws,
      eventsDataJson: new TextDecoder().decode(eventsData),
      targetUrl: `${setup.bridgeUrl}${BRIDGE_PATH}`,
    });
  },
  {
    requiredPermissions: ["detection:read"],
    // Skip the generic per-user API bucket — this route enforces
    // its own bridge-specific bucket (30 / 60s) so bridge usage and
    // generic API traffic do not starve each other.
    skipApiRateLimit: true,
  },
);
