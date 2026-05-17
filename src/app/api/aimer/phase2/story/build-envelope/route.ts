import "server-only";

import { NextResponse } from "next/server";

import { recordManualMint } from "@/lib/aimer/phase2/manual-mint";
import { buildPhase2Push } from "@/lib/aimer/phase2/orchestrate";
import { loadSingleStoryWireItem } from "@/lib/aimer/phase2/story-push";
import type { Phase2SchemaVersion } from "@/lib/aimer/phase2/wire-types";
import { getAimerIntegrationSetup } from "@/lib/aimer/setup-status";
import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import { withAuth } from "@/lib/auth/guard";
import { hasPermission } from "@/lib/auth/permissions";

/**
 * `POST /api/aimer/phase2/story/build-envelope`
 *
 * Manual Send-to-aimer-web — single-Story mint route per RFC 0002
 * §6.1 / sub-issue #493. The browser calls this with `customerId` +
 * `storyId` + optional `forceRefresh`; the route loads the Story,
 * builds the `phase2.story.v1` payload (batch of size 1), mints the
 * multipart components via {@link buildPhase2Push}, INSERTs a row in
 * `aimer_phase2_manual_mint` keyed on the freshly minted
 * `context_jti`, and returns the multipart parts + the composed
 * `aimer_endpoint_url` for the browser to POST to.
 *
 * The browser POSTs the multipart to aimer-web, then calls
 * `POST /api/aimer/phase2/story/ack-manual` on 2xx to commit β +
 * audit server-side.
 *
 * Input contract is **single-Story per call** — bulk Send is not in
 * scope for v1 (RFC 0002 §493). A caller that supplies `storyIds`
 * (plural) or an array gets a 400 `invalid_request`.
 */

const SCHEMA_VERSION: Phase2SchemaVersion = "phase2.story.v1";
const AIMER_PATH = "/api/phase2/story/batch" as const;

interface RequestBody {
  customerId?: unknown;
  storyId?: unknown;
  storyIds?: unknown;
  forceRefresh?: unknown;
}

function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

function isDecimalString(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && /^[0-9]+$/.test(value)
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

export const POST = withAuth(
  async (request, _context, session) => {
    let body: RequestBody;
    try {
      body = (await request.json()) as RequestBody;
    } catch {
      return jsonError("invalid_json", 400);
    }

    // Single-Story per call: reject any caller that supplies
    // `storyIds` (plural / array) so bulk-Send cannot sneak in
    // through this v1 route. RFC 0002 §493 documents this explicitly.
    if (body.storyIds !== undefined) {
      return jsonError("invalid_request", 400);
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

    const forceRefresh = body.forceRefresh === true;

    // Tenant scope: a `triage:read` user for tenant A must not be
    // able to mint an envelope for tenant B even if they construct
    // the request directly. Admins (`customers:access-all`) skip.
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

    // Load the Story + members. Returns null when the row does not
    // exist in this tenant's DB — same 404 surface as cross-tenant
    // probes so the two cases are indistinguishable from outside.
    const wireItem = await loadSingleStoryWireItem({
      customerId,
      storyId,
      forceRefresh,
    });
    if (wireItem === null) {
      return jsonError("story_not_found", 404);
    }

    let tokens: Awaited<ReturnType<typeof buildPhase2Push>>;
    try {
      tokens = await buildPhase2Push({
        schemaVersion: SCHEMA_VERSION,
        customerId,
        accountId: session.accountId,
        payload: {
          // `external_key` + `source_aice_id` are overwritten by the
          // orchestrator from the customer record + integration
          // setup; pass placeholders to satisfy the schema's
          // non-empty checks.
          external_key: "_",
          source_aice_id: "_",
          stories: [wireItem],
        },
      });
    } catch (err) {
      // Setup not configured / customer missing external_key /
      // customer not found. The route surfaces the structured code
      // so the toast can offer remediation.
      if (
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        typeof (err as { code: unknown }).code === "string"
      ) {
        return jsonError(
          (err as { code: string }).code,
          err instanceof Error && "code" in err ? 409 : 500,
        );
      }
      throw err;
    }

    // Record the ledger row BEFORE returning so the browser cannot
    // observe an envelope that the eventual `ack-manual` would
    // reject as `replay_or_unknown_jti`. Best-effort idempotent on
    // duplicate JTIs (which the orchestrator's randomness guard
    // makes vanishingly unlikely).
    await recordManualMint(customerId, {
      contextJti: tokens.context_jti,
      storyId,
      accountId: session.accountId,
      forceRefresh,
    });

    const setup = await getAimerIntegrationSetup();
    const aimerEndpointUrl = composeAimerEndpointUrl(
      setup.bridgeUrl,
      AIMER_PATH,
    );

    return NextResponse.json({
      context_token: tokens.context_token,
      events_envelope: tokens.events_envelope,
      events_data: tokens.events_data,
      context_jti: tokens.context_jti,
      aimer_endpoint_path: AIMER_PATH,
      aimer_endpoint_url: aimerEndpointUrl,
      schema_version: SCHEMA_VERSION,
    });
  },
  {
    requiredPermissions: ["triage:read"],
  },
);
