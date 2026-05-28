import "server-only";

import { NextResponse } from "next/server";
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
 * - `200 OK` with `{ tier, href, severityScore, likelihoodScore,
 *   scoreKind }` when the upstream report exists, the priority tier
 *   is `CRITICAL` or `HIGH`, and the upstream `link` validated as a
 *   relative path. `href` is the absolute aimer-web URL composed
 *   server-side from `bridgeUrl + link`.
 * - `204 No Content` for every other "render nothing" case:
 *   integration unconfigured (bridge URL / `aice_id` / signing key
 *   missing), upstream `404`, `exists: false`, tier `LOW` / `MEDIUM`,
 *   malformed / non-relative `link`, or upstream fetch error.
 *   Malformed-upstream and fetch-error cases log server-side at
 *   `warn` so operators can debug; the wire response stays `204` to
 *   keep the client policy trivial.
 * - `401` (no session — emitted by `withAuth`).
 * - `404 not_found` for cross-tenant `customerId` (concealment —
 *   matches the build-envelope route at
 *   `src/app/api/aimer/phase2/story/build-envelope/route.ts:105`).
 *
 * The bridge call itself is blocked on aicers/aimer-web#296
 * finalizing the read-side auth contract. Until that lands the
 * upstream fetch uses placeholder request shape that #296 will
 * replace; the surface contract above is stable independently.
 */

const AIMER_PATH_PREFIX = "/api/analysis/story" as const;
const AIMER_PATH_SUFFIX = "/summary" as const;
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
 */
function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (!value.startsWith("/")) return false;
  if (value.startsWith("//")) return false;
  if (value.includes("\\")) return false;
  for (const segment of value.split("/")) {
    if (segment === "..") return false;
  }
  return true;
}

function composeHref(bridgeUrl: string, link: string): string {
  const trimmed = bridgeUrl.replace(/\/+$/, "");
  return `${trimmed}${link}`;
}

function composeUpstreamUrl(bridgeUrl: string, storyId: string): string {
  const trimmed = bridgeUrl.replace(/\/+$/, "");
  return `${trimmed}${AIMER_PATH_PREFIX}/${encodeURIComponent(storyId)}${AIMER_PATH_SUFFIX}`;
}

async function fetchUpstreamSummary(
  upstreamUrl: string,
  aiceId: string,
): Promise<UpstreamSummary | null | "fetch_error" | "upstream_missing"> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        // Placeholder request-identification header. The real
        // read-side auth artifact lands with aicers/aimer-web#296;
        // until then the upstream stub interprets the header as the
        // tenant `iss` claim it would later read from the signed
        // request.
        "x-aice-id": aiceId,
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
    // summary fetch only needs the bridge URL, the `aice_id` (used
    // as the tenant identifier on the upstream request), and the
    // read-side auth artifact — today the active signing key, which
    // aicers/aimer-web#296 will finalize as the read-side signing
    // material.
    const settings = await getAimerIntegrationSettings();
    const hasSigningKey = hasActiveAimerSigningKey();
    if (!settings.bridgeUrl || !settings.aiceId || !hasSigningKey) {
      return noContent();
    }

    const upstreamUrl = composeUpstreamUrl(settings.bridgeUrl, storyId);
    const upstream = await fetchUpstreamSummary(upstreamUrl, settings.aiceId);
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

    const href = composeHref(settings.bridgeUrl, upstream.link);
    return NextResponse.json(
      {
        tier: upstream.priority_tier,
        href,
        severityScore: upstream.severity_score,
        likelihoodScore: upstream.likelihood_score,
        scoreKind: upstream.score_kind,
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
