"use server";

import { getCurrentSession } from "@/lib/auth/session";
import {
  type AnalyticsDimension,
  type AnalyticsTopN,
  computeFrequencyPeriodSeconds,
  countEventsByCategory,
  countEventsByCountry,
  countEventsByKind,
  countEventsByLevel,
  countEventsByOriginatorIpAddress,
  countEventsByResponderIpAddress,
  DetectionForbiddenError,
  DetectionUnauthorizedError,
  eventFrequencySeries,
  type Filter,
  isAnalyticsDimension,
  isAnalyticsTopN,
  toEventListFilterInput,
} from "@/lib/detection";
import {
  ReviewForbiddenError,
  ReviewInvalidArgumentError,
  ReviewUnknownGraphQLError,
} from "@/lib/review/errors";

/**
 * Top N counter row. `value` is always a string for client display —
 * categorical (number-keyed) dimensions are translated by the
 * dispatch helper here so the UI never has to map a `ThreatLevel`
 * enum back to a label, and `count` is the raw bucket count REview
 * returns. Two parallel arrays keep the chart's render code trivial.
 */
export interface AnalyticsTopNData {
  values: string[];
  counts: number[];
}

export interface RunAnalyticsQueryOk {
  ok: true;
  dimension: AnalyticsDimension;
  topN: AnalyticsTopNData;
  series: number[];
  /** Bucket size used for the time series (seconds). */
  periodSeconds: number;
  /** ISO bounds the time series covers, or `null` when the filter omits them. */
  rangeStart: string | null;
  rangeEnd: string | null;
}

export interface RunAnalyticsQueryErr {
  ok: false;
  /**
   * `forbidden-customer-scope` is the typed translation of
   * {@link DetectionForbiddenError} — the inbound `Filter` references
   * a customer ID outside the caller's effective scope (#384's BFF
   * intersection check, applied uniformly to the analytics dispatch
   * path) **or** the caller's effective customer scope is empty
   * (Reviewer Round 2: empty-scope sessions flow through the same
   * customer-scope gate). Distinct from `forbidden` (caller lacks
   * `detection:read`) so the UI can render an actionable message.
   */
  code:
    | "unauthenticated"
    | "forbidden"
    | "forbidden-customer-scope"
    | "server-error"
    | "invalid-input";
}

export type RunAnalyticsQueryResult =
  | RunAnalyticsQueryOk
  | RunAnalyticsQueryErr;

/**
 * Fetch both halves of the analytics strip in one round-trip pair —
 * the dimension's Top N counter and `eventFrequencySeries` over the
 * filter's time range. The two queries run in parallel so the strip's
 * loading state resolves on the slower of the two rather than the
 * sum.
 *
 * Authorization mirrors `runEventQuery`: this wrapper only resolves
 * the session and translates known error shapes; the underlying
 * `countEventsBy*` / `eventFrequencySeries` server actions enforce
 * `detection:read` and resolve the customer scope themselves.
 */
export async function runAnalyticsQuery(
  filter: Filter,
  dimension: AnalyticsDimension,
  topN: AnalyticsTopN,
): Promise<RunAnalyticsQueryResult> {
  // Reviewer Round 1 (P2 server-side trust): server actions are
  // callable with crafted payloads by an authenticated browser
  // session; the TypeScript narrowing on the client is not a
  // boundary check. Reject anything outside the documented
  // vocabulary so a hand-rolled call cannot ask for an oversized
  // `first` argument or force the `dispatch` switch onto a path
  // that yields a generic server error.
  if (!isAnalyticsDimension(dimension) || !isAnalyticsTopN(topN)) {
    return { ok: false, code: "invalid-input" };
  }

  const session = await getCurrentSession();
  if (!session) {
    return { ok: false, code: "unauthenticated" };
  }

  const input =
    filter.mode === "structured" ? toEventListFilterInput(filter) : null;
  const periodSeconds = computeFrequencyPeriodSeconds(input ?? {});

  try {
    const [counter, series] = await Promise.all([
      fetchTopN(session, filter, dimension, topN),
      eventFrequencySeries(session, filter, periodSeconds),
    ]);
    return {
      ok: true,
      dimension,
      topN: {
        values: counter.values.map((v) => String(v)),
        counts: counter.counts,
      },
      series,
      periodSeconds,
      rangeStart: input?.start ?? null,
      rangeEnd: input?.end ?? null,
    };
  } catch (err) {
    if (err instanceof DetectionForbiddenError) {
      return { ok: false, code: "forbidden-customer-scope" };
    }
    if (err instanceof DetectionUnauthorizedError) {
      return { ok: false, code: "forbidden" };
    }
    // #405 I: review's GraphQL-layer denials must surface as their
    // typed code, not collapse into the generic `server-error`
    // bucket. The shell already differentiates `forbidden` vs.
    // `forbidden-customer-scope` panels — `ReviewForbiddenError`
    // routes through the former, while `ReviewInvalidArgumentError`
    // joins the existing `invalid-input` branch so the operator sees
    // a refresh-prompt rather than a crash banner.
    // `ReviewUnknownGraphQLError` (review answered with an
    // unrecognised code) deliberately re-throws past the
    // `server-error` fallback per the security guardrail (Reviewer
    // Round 2 P1) — masking a new review-side error code as a
    // generic graceful state would defeat the guardrail. Plain
    // `Error`s (transport, BFF bugs) still fall through to
    // `server-error`.
    if (err instanceof ReviewForbiddenError) {
      return { ok: false, code: "forbidden" };
    }
    if (err instanceof ReviewInvalidArgumentError) {
      return { ok: false, code: "invalid-input" };
    }
    if (err instanceof ReviewUnknownGraphQLError) {
      throw err;
    }
    return { ok: false, code: "server-error" };
  }
}

async function fetchTopN(
  session: Parameters<typeof eventFrequencySeries>[0],
  filter: Filter,
  dimension: AnalyticsDimension,
  topN: AnalyticsTopN,
): Promise<{ values: ReadonlyArray<string | number>; counts: number[] }> {
  switch (dimension) {
    case "srcIp":
      return countEventsByOriginatorIpAddress(session, filter, topN);
    case "dstIp":
      return countEventsByResponderIpAddress(session, filter, topN);
    case "country":
      return countEventsByCountry(session, filter, topN);
    case "category":
      return countEventsByCategory(session, filter, topN);
    case "level":
      return countEventsByLevel(session, filter, topN);
    case "kind":
      return countEventsByKind(session, filter, topN);
  }
}
