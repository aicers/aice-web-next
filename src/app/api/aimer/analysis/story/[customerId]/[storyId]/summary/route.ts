import "server-only";

import { NextResponse } from "next/server";
import { resolveCustomerExternalKey } from "@/lib/aimer/analysis/customer-external-key";
import {
  buildReadAuthTokenPayload,
  signReadAuthToken,
} from "@/lib/aimer/analysis/read-auth-token";
import { getAimerIntegrationSettings } from "@/lib/aimer/settings";
import { hasActiveAimerSigningKey } from "@/lib/aimer/signing-key";
import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import { withAuth } from "@/lib/auth/guard";
import { hasPermission } from "@/lib/auth/permissions";

/**
 * `GET /api/aimer/analysis/story/[customerId]/[storyId]/summary`
 *
 * AI narrative analysis badge resolver (RFC 0002 §"What aice-web-next
 * surfaces", aicers/aice-web-next#645). The Triage Stories surface
 * calls this once per visible Story to decide whether to render the
 * deep-link badge. The client treats anything other than `200` as
 * "no badge".
 *
 * Surfaces:
 * - `200 OK` with `{ exists: true, priority_tier, severity_score,
 *   likelihood_score, score_kind, link }` (matches the contract
 *   defined in #645 "Internal route response contract") when the
 *   upstream report exists, the priority tier is `CRITICAL` or
 *   `HIGH`, and the upstream `link` validated as a relative path.
 *   `link` on the wire is the absolute aimer-web URL composed
 *   server-side from `bridgeUrl + upstream.link`; the client never
 *   sees `bridgeUrl` as a separate value.
 * - `204 No Content` for every other "render nothing" case:
 *   integration unconfigured (bridge URL / `aice_id` / signing key
 *   missing, or the customer has no `external_key`), upstream `404`,
 *   `exists: false`, tier `LOW` / `MEDIUM`, malformed / non-relative
 *   `link`, or upstream fetch error. Malformed-upstream and
 *   fetch-error cases log server-side at `warn` so operators can
 *   debug; the wire response stays `204` to keep the client policy
 *   trivial.
 * - `401` (no session — emitted by `withAuth`).
 * - `404 not_found` for cross-tenant `customerId` (concealment —
 *   matches the build-envelope route at
 *   `src/app/api/aimer/phase2/story/build-envelope/route.ts:105`).
 *
 * Upstream contract (aicers/aimer-web#296, landed): the read-side
 * endpoint is customer-scoped — `GET /api/customers/{customer_id}
 * /analysis/story/{story_id}/summary` — where `{customer_id}` is the
 * resolved `customers.external_key` (the cross-system bridge
 * identifier paired with aimer-web), not the internal numeric id.
 * `story_id` is not globally unique across tenants so the customer
 * scope is required.
 *
 * Read-side auth: every upstream request carries an
 * `Authorization: Bearer <jws>` header signed with the active Aimer
 * signing key. The payload mirrors the Phase 2 context-token shape
 * (`iss`, `aud`, `aice_id`, `customer_ids: [external_key]`, `iat`,
 * `exp`, `jti`) so aimer-web verifies push and read paths through a
 * single JWS-validation path keyed on the active `kid`.
 */

const UPSTREAM_PATH_PREFIX = "/api/customers" as const;
const UPSTREAM_STORY_INFIX = "/analysis/story" as const;
const UPSTREAM_PATH_SUFFIX = "/summary" as const;
const UPSTREAM_TIMEOUT_MS = 5_000;

type SurfaceTier = "CRITICAL" | "HIGH";

interface UpstreamSummary {
  exists?: unknown;
  priority_tier?: unknown;
  severity_score?: unknown;
  likelihood_score?: unknown;
  score_kind?: unknown;
  link?: unknown;
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

function isDecimalString(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && /^[0-9]+$/.test(value)
  );
}

function isNumberInUnitRange(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function isSurfaceTier(value: unknown): value is SurfaceTier {
  return value === "CRITICAL" || value === "HIGH";
}

function isScoreKind(value: unknown): value is "leaf" | "aggregate" {
  return value === "leaf" || value === "aggregate";
}

/**
 * Reject anything that is not a strictly relative path. An upstream
 * that returns an absolute URL, a protocol-relative `//host/...`
 * authority, a `..` traversal, or a `\` smuggled separator is treated
 * as malformed — the badge composes the absolute href from the
 * trusted server-side `bridgeUrl`, never from the remote value.
 *
 * Percent-encoded dot segments (`%2e%2e`, `%2E%2e.`, `.%2e`, …)
 * are also rejected: the browser normalizes them back to `..`
 * during URL parsing, so a literal-only check would still let
 * `/analysis/%2e%2e/admin` escape the `/analysis/` namespace.
 */
function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (!value.startsWith("/")) return false;
  if (value.startsWith("//")) return false;
  if (value.includes("\\")) return false;
  for (const segment of value.split("/")) {
    if (containsDotSegment(segment)) return false;
  }
  return true;
}

/**
 * `true` when the URL-decoded segment is `.` or `..`. Mixed-case
 * percent encodings (`%2E`, `%2e`) and partially-encoded forms
 * (`.%2e`, `%2e.`) all collapse to dots after decoding and must
 * therefore be rejected together with the literal `..` form.
 */
function containsDotSegment(segment: string): boolean {
  if (segment === "." || segment === "..") return true;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // A malformed percent escape is itself untrusted input — treat
    // it as a traversal attempt rather than letting the raw segment
    // ride through.
    return true;
  }
  return decoded === "." || decoded === "..";
}

function composeHref(bridgeUrl: string, link: string): string {
  const trimmed = bridgeUrl.replace(/\/+$/, "");
  return `${trimmed}${link}`;
}

function composeUpstreamUrl(
  bridgeUrl: string,
  externalKey: string,
  storyId: string,
): string {
  const trimmed = bridgeUrl.replace(/\/+$/, "");
  return `${trimmed}${UPSTREAM_PATH_PREFIX}/${encodeURIComponent(externalKey)}${UPSTREAM_STORY_INFIX}/${encodeURIComponent(storyId)}${UPSTREAM_PATH_SUFFIX}`;
}

async function fetchUpstreamSummary(
  upstreamUrl: string,
  bearerToken: string,
): Promise<UpstreamSummary | null | "fetch_error" | "upstream_missing"> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        // Read-side auth artifact finalized in aicers/aimer-web#296.
        // The JWS is signed with the active Aimer signing key and
        // carries `aice_id` + `customer_ids: [external_key]` so
        // aimer-web can verify push and read paths through the same
        // JWS-validation path keyed on `kid`.
        authorization: `Bearer ${bearerToken}`,
      },
      signal: controller.signal,
      cache: "no-store",
    });
  } catch {
    return "fetch_error";
  } finally {
    clearTimeout(timeout);
  }
  if (response.status === 404) return "upstream_missing";
  if (!response.ok) return "fetch_error";
  try {
    return (await response.json()) as UpstreamSummary;
  } catch {
    return "fetch_error";
  }
}

export const GET = withAuth(
  async (_request, context, session) => {
    const { customerId: customerIdParam, storyId: storyIdParam } =
      (await context.params) as { customerId?: string; storyId?: string };

    const customerId = Number(customerIdParam);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      return NextResponse.json(
        { error: "invalid_customer_id" },
        {
          status: 400,
        },
      );
    }
    if (!isDecimalString(storyIdParam)) {
      return NextResponse.json({ error: "invalid_story_id" }, { status: 400 });
    }
    const storyId = storyIdParam;

    // Tenant scope: a `triage:read` user for tenant A must not be
    // able to probe tenant B's report existence. Admins
    // (`customers:access-all`) skip. Non-admins out of scope get a
    // 404 to keep the response indistinguishable from "no such story"
    // — matches the build-envelope route's concealment surface.
    const isAdmin = await hasPermission(session.roles, "customers:access-all");
    if (!isAdmin) {
      const ids = await resolveEffectiveCustomerIds(
        session.accountId,
        session.roles,
      );
      if (!ids.includes(customerId)) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
    }

    // Read-side setup check. The Send-to-aimer-web flow needs
    // `defaultModelName` + `defaultModel` too, but the read-side
    // summary fetch only needs the bridge URL, the `aice_id` (the
    // `iss` claim on the signed read token), and the active Aimer
    // signing key (used to sign the read-side auth token finalized
    // in aicers/aimer-web#296).
    const settings = await getAimerIntegrationSettings();
    const hasSigningKey = hasActiveAimerSigningKey();
    if (!settings.bridgeUrl || !settings.aiceId || !hasSigningKey) {
      return noContent();
    }

    // Resolve the customer's `external_key` — that is the identifier
    // aimer-web knows the customer by, and it is the value embedded
    // in both the upstream URL path and the signed token's
    // `customer_ids` claim. If the customer has no `external_key`
    // configured, no upstream call is possible — collapse to 204.
    const externalKey = await resolveCustomerExternalKey(customerId);
    if (!externalKey) {
      return noContent();
    }

    const tokenPayload = buildReadAuthTokenPayload(
      settings.aiceId,
      externalKey,
    );
    let bearerToken: string;
    try {
      bearerToken = await signReadAuthToken(tokenPayload);
    } catch (err) {
      console.warn(
        "[aimer.analysis.summary] read-auth token signing failed: customerId=%d storyId=%s err=%s",
        customerId,
        storyId,
        err instanceof Error ? err.message : String(err),
      );
      return noContent();
    }

    const upstreamUrl = composeUpstreamUrl(
      settings.bridgeUrl,
      externalKey,
      storyId,
    );
    const upstream = await fetchUpstreamSummary(upstreamUrl, bearerToken);
    if (upstream === "upstream_missing") {
      return noContent();
    }
    if (upstream === "fetch_error") {
      console.warn(
        "[aimer.analysis.summary] upstream fetch error: customerId=%d storyId=%s url=%s",
        customerId,
        storyId,
        upstreamUrl,
      );
      return noContent();
    }
    if (upstream === null) return noContent();

    if (upstream.exists !== true) return noContent();

    if (!isSurfaceTier(upstream.priority_tier)) return noContent();
    if (!isNumberInUnitRange(upstream.severity_score)) {
      console.warn(
        "[aimer.analysis.summary] malformed severity_score: customerId=%d storyId=%s",
        customerId,
        storyId,
      );
      return noContent();
    }
    if (!isNumberInUnitRange(upstream.likelihood_score)) {
      console.warn(
        "[aimer.analysis.summary] malformed likelihood_score: customerId=%d storyId=%s",
        customerId,
        storyId,
      );
      return noContent();
    }
    if (!isScoreKind(upstream.score_kind)) {
      console.warn(
        "[aimer.analysis.summary] malformed score_kind: customerId=%d storyId=%s",
        customerId,
        storyId,
      );
      return noContent();
    }
    if (!isSafeRelativePath(upstream.link)) {
      console.warn(
        "[aimer.analysis.summary] malformed link rejected: customerId=%d storyId=%s",
        customerId,
        storyId,
      );
      return noContent();
    }

    const link = composeHref(settings.bridgeUrl, upstream.link);
    return NextResponse.json(
      {
        exists: true,
        priority_tier: upstream.priority_tier,
        severity_score: upstream.severity_score,
        likelihood_score: upstream.likelihood_score,
        score_kind: upstream.score_kind,
        link,
      },
      {
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  },
  {
    requiredPermissions: ["triage:read"],
  },
);
