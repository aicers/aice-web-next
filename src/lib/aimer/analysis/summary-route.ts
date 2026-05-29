import "server-only";

import { NextResponse } from "next/server";

import { getAimerIntegrationSettings } from "@/lib/aimer/settings";
import { hasActiveAimerSigningKey } from "@/lib/aimer/signing-key";

import { resolveCustomerExternalKey } from "./customer-external-key";
import {
  buildReadAuthTokenPayload,
  signReadAuthToken,
} from "./read-auth-token";

/**
 * Server-side composition for the AI-analysis summary routes (#645,
 * #653).
 *
 * The story route and the Phase 2 report routes (#646) share the same
 * upstream contract: resolve the customer's `external_key`, sign a
 * read-side JWS with the active Aimer signing key, fetch the
 * customer-scoped upstream summary, validate the surface threshold and
 * the relative `link`, and map the result to a `200` body or a `204`.
 * This module owns all of that so each route is a thin wrapper that only
 * supplies its own upstream resource path (and its own tenant-scope
 * concealment policy, which stays in the route because it is auth
 * policy, not upstream composition).
 *
 * Upstream contract (aicers/aimer-web#296, landed): the read-side
 * endpoint is customer-scoped — `GET /api/customers/{customer_id}{...}`
 * — where `{customer_id}` is the resolved `customers.external_key` (the
 * cross-system bridge identifier paired with aimer-web), not the
 * internal numeric id.
 */

const UPSTREAM_CUSTOMERS_PREFIX = "/api/customers" as const;
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

export function noContent(): Response {
  return new Response(null, { status: 204 });
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
 * Reject anything that is not a strictly relative path. An upstream that
 * returns an absolute URL, a protocol-relative `//host/...` authority, a
 * `..` traversal, or a `\` smuggled separator is treated as malformed —
 * the badge composes the absolute href from the trusted server-side
 * `bridgeUrl`, never from the remote value.
 *
 * Percent-encoded dot segments (`%2e%2e`, `%2E%2e.`, `.%2e`, …) are also
 * rejected: the browser normalizes them back to `..` during URL parsing,
 * so a literal-only check would still let `/analysis/%2e%2e/admin` escape
 * the `/analysis/` namespace.
 */
export function isSafeRelativePath(value: unknown): value is string {
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
 * `true` when the URL-decoded segment is `.` or `..`. Mixed-case percent
 * encodings (`%2E`, `%2e`) and partially-encoded forms (`.%2e`, `%2e.`)
 * all collapse to dots after decoding and must therefore be rejected
 * together with the literal `..` form.
 */
function containsDotSegment(segment: string): boolean {
  if (segment === "." || segment === "..") return true;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // A malformed percent escape is itself untrusted input — treat it as
    // a traversal attempt rather than letting the raw segment ride
    // through.
    return true;
  }
  return decoded === "." || decoded === "..";
}

function composeHref(bridgeUrl: string, link: string): string {
  const trimmed = bridgeUrl.replace(/\/+$/, "");
  return `${trimmed}${link}`;
}

/**
 * Compose the absolute upstream URL from the trusted `bridgeUrl`, the
 * customer scope (`/api/customers/{external_key}`), and the
 * surface-specific `resourcePath` (e.g.
 * `/analysis/story/{story_id}/summary`). The caller supplies an
 * already-encoded `resourcePath`; `externalKey` is encoded here.
 */
function composeUpstreamUrl(
  bridgeUrl: string,
  externalKey: string,
  resourcePath: string,
): string {
  const trimmed = bridgeUrl.replace(/\/+$/, "");
  return `${trimmed}${UPSTREAM_CUSTOMERS_PREFIX}/${encodeURIComponent(externalKey)}${resourcePath}`;
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

export interface AnalysisSummaryResolution {
  /**
   * Internal numeric customer id whose `external_key` scopes the upstream
   * call. The caller is responsible for tenant-scope concealment before
   * invoking this helper.
   */
  customerId: number;
  /**
   * Builds the surface-specific upstream resource path that follows
   * `/api/customers/{external_key}` — e.g.
   * `/analysis/story/${encodeURIComponent(storyId)}/summary`. Returns an
   * already-encoded path. The `external_key` segment is added by the
   * helper.
   */
  buildResourcePath: () => string;
  /**
   * Short context string appended to `warn`-level server logs so
   * operators can attribute a malformed-upstream / fetch-error log line
   * to a specific surface and identifiers.
   */
  logContext: string;
}

/**
 * Resolve an AI-analysis summary into a `200` body or a `204`, sharing
 * the bridge-URL composition, JWS attach, upstream fetch, field
 * validation, and link validation across every analysis summary route.
 *
 * `200 OK` body matches the documented contract (#645): `{ exists: true,
 * priority_tier, severity_score, likelihood_score, score_kind, link }`
 * with `link` carrying the validated absolute aimer-web URL.
 *
 * `204 No Content` for every "render nothing" case: integration
 * unconfigured (bridge URL / `aice_id` / signing key missing, or no
 * `external_key`), upstream `404`, `exists: false`, tier `LOW` /
 * `MEDIUM`, malformed fields, malformed / non-relative `link`, upstream
 * fetch error, or read-auth signing failure.
 */
export async function resolveAnalysisSummaryResponse({
  customerId,
  buildResourcePath,
  logContext,
}: AnalysisSummaryResolution): Promise<Response> {
  // Read-side setup check. The Send-to-aimer-web flow needs
  // `defaultModelName` + `defaultModel` too, but the read-side summary
  // fetch only needs the bridge URL, the `aice_id` (the `iss` claim on
  // the signed read token), and the active Aimer signing key.
  const settings = await getAimerIntegrationSettings();
  const hasSigningKey = hasActiveAimerSigningKey();
  if (!settings.bridgeUrl || !settings.aiceId || !hasSigningKey) {
    return noContent();
  }

  // Resolve the customer's `external_key` — the identifier aimer-web
  // knows the customer by, embedded in both the upstream URL path and
  // the signed token's `customer_ids` claim. No `external_key` ⇒ no
  // upstream call possible ⇒ 204.
  const externalKey = await resolveCustomerExternalKey(customerId);
  if (!externalKey) {
    return noContent();
  }

  const tokenPayload = buildReadAuthTokenPayload(settings.aiceId, externalKey);
  let bearerToken: string;
  try {
    bearerToken = await signReadAuthToken(tokenPayload);
  } catch (err) {
    console.warn(
      "[aimer.analysis.summary] read-auth token signing failed: %s err=%s",
      logContext,
      err instanceof Error ? err.message : String(err),
    );
    return noContent();
  }

  const upstreamUrl = composeUpstreamUrl(
    settings.bridgeUrl,
    externalKey,
    buildResourcePath(),
  );
  const upstream = await fetchUpstreamSummary(upstreamUrl, bearerToken);
  if (upstream === "upstream_missing") {
    return noContent();
  }
  if (upstream === "fetch_error") {
    console.warn(
      "[aimer.analysis.summary] upstream fetch error: %s url=%s",
      logContext,
      upstreamUrl,
    );
    return noContent();
  }
  if (upstream === null) return noContent();

  if (upstream.exists !== true) return noContent();

  if (!isSurfaceTier(upstream.priority_tier)) return noContent();
  if (!isNumberInUnitRange(upstream.severity_score)) {
    console.warn(
      "[aimer.analysis.summary] malformed severity_score: %s",
      logContext,
    );
    return noContent();
  }
  if (!isNumberInUnitRange(upstream.likelihood_score)) {
    console.warn(
      "[aimer.analysis.summary] malformed likelihood_score: %s",
      logContext,
    );
    return noContent();
  }
  if (!isScoreKind(upstream.score_kind)) {
    console.warn(
      "[aimer.analysis.summary] malformed score_kind: %s",
      logContext,
    );
    return noContent();
  }
  if (!isSafeRelativePath(upstream.link)) {
    console.warn(
      "[aimer.analysis.summary] malformed link rejected: %s",
      logContext,
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
}
