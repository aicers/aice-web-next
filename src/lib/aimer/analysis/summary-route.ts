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

/**
 * Which analysis surface a resolution belongs to. Carried into the
 * structured log line so an external collector can break the
 * outcome / reason counters down by surface (#646 "Structured
 * observability"). `story` is the #645 Stories badge; `live` / `daily`
 * are the Phase 2 dashboard report cards.
 */
export type AnalysisSurface = "story" | "live" | "daily";

/**
 * Outcome of a resolution — `200` (positive summary body) or `204`
 * (render nothing). Stringified so the log line reads as a stable
 * label rather than a number.
 */
type ResolutionOutcome = "200" | "204";

/**
 * Why a resolution landed where it did. Mirrors the categories called
 * out in #646 so the structured log doubles as the data source for the
 * deferred Prometheus counters:
 * - `ok` — positive `200` summary emitted.
 * - `unconfigured` — bridge URL / `aice_id` / signing key / `external_key`
 *   missing; no upstream call possible.
 * - `signing_error` — read-auth token signing failed.
 * - `upstream_missing` — upstream `404` or `exists: false`.
 * - `tier_below_threshold` — tier `LOW` / `MEDIUM`.
 * - `malformed_upstream` — malformed field or non-relative `link`.
 * - `fetch_error` — upstream fetch failed / timed out / unparseable.
 */
type ResolutionReason =
  | "ok"
  | "unconfigured"
  | "signing_error"
  | "upstream_missing"
  | "tier_below_threshold"
  | "malformed_upstream"
  | "fetch_error";

/**
 * Reasons that indicate a genuine fault (vs. an expected "render
 * nothing") and are therefore emitted at `warn` level so they surface
 * in alerting; the benign 204 cases and the positive 200 path log at
 * `info`. This keeps the single-line-per-resolution contract while
 * preserving the warn signal the existing tests assert on.
 */
const WARN_REASONS: ReadonlySet<ResolutionReason> = new Set<ResolutionReason>([
  "signing_error",
  "malformed_upstream",
  "fetch_error",
]);

/**
 * Emit the single structured resolution line (#646). Carries `surface`
 * / `outcome` / `reason` as parseable `key=value` fields plus the
 * caller's `logContext` so an external collector can derive per-surface
 * 200/204 and 204-reason counters without a metrics surface in the
 * repo yet.
 */
function logResolution(
  surface: AnalysisSurface,
  outcome: ResolutionOutcome,
  reason: ResolutionReason,
  logContext: string,
): void {
  const fields = `surface=${surface} outcome=${outcome} reason=${reason} ${logContext}`;
  if (WARN_REASONS.has(reason)) {
    console.warn("[aimer.analysis.summary] %s", fields);
  } else {
    console.info("[aimer.analysis.summary] %s", fields);
  }
}

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
export function composeUpstreamUrl(
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
   * Which surface is resolving — `story` / `live` / `daily`. Carried
   * into the structured log line so the per-surface outcome / reason
   * counters can be derived downstream (#646).
   */
  surface: AnalysisSurface;
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
  surface,
  buildResourcePath,
  logContext,
}: AnalysisSummaryResolution): Promise<Response> {
  // Emit the single structured resolution line and return the
  // corresponding 204. Centralizing the negative return keeps the
  // "one log line per resolution" contract: every render-nothing path
  // routes through here with its own `reason`.
  const resolveNegative = (reason: ResolutionReason): Response => {
    logResolution(surface, "204", reason, logContext);
    return noContent();
  };

  // Read-side setup check. The Send-to-aimer-web flow needs
  // `defaultModelName` + `defaultModel` too, but the read-side summary
  // fetch only needs the bridge URL, the `aice_id` (the `iss` claim on
  // the signed read token), and the active Aimer signing key.
  const settings = await getAimerIntegrationSettings();
  const hasSigningKey = hasActiveAimerSigningKey();
  if (!settings.bridgeUrl || !settings.aiceId || !hasSigningKey) {
    return resolveNegative("unconfigured");
  }

  // Resolve the customer's `external_key` — the identifier aimer-web
  // knows the customer by, embedded in both the upstream URL path and
  // the signed token's `customer_ids` claim. No `external_key` ⇒ no
  // upstream call possible ⇒ 204.
  const externalKey = await resolveCustomerExternalKey(customerId);
  if (!externalKey) {
    return resolveNegative("unconfigured");
  }

  const tokenPayload = buildReadAuthTokenPayload(settings.aiceId, externalKey);
  let bearerToken: string;
  try {
    bearerToken = await signReadAuthToken(tokenPayload);
  } catch {
    return resolveNegative("signing_error");
  }

  const upstreamUrl = composeUpstreamUrl(
    settings.bridgeUrl,
    externalKey,
    buildResourcePath(),
  );
  const upstream = await fetchUpstreamSummary(upstreamUrl, bearerToken);
  if (upstream === "upstream_missing") {
    return resolveNegative("upstream_missing");
  }
  if (upstream === "fetch_error") {
    return resolveNegative("fetch_error");
  }
  if (upstream === null) return resolveNegative("fetch_error");

  if (upstream.exists !== true) return resolveNegative("upstream_missing");

  if (!isSurfaceTier(upstream.priority_tier)) {
    return resolveNegative("tier_below_threshold");
  }
  if (!isNumberInUnitRange(upstream.severity_score)) {
    return resolveNegative("malformed_upstream");
  }
  if (!isNumberInUnitRange(upstream.likelihood_score)) {
    return resolveNegative("malformed_upstream");
  }
  if (!isScoreKind(upstream.score_kind)) {
    return resolveNegative("malformed_upstream");
  }
  if (!isSafeRelativePath(upstream.link)) {
    return resolveNegative("malformed_upstream");
  }

  const link = composeHref(settings.bridgeUrl, upstream.link);
  logResolution(surface, "200", "ok", logContext);
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
