"use server";

import { getCurrentSession } from "@/lib/auth/session";
import {
  DetectionForbiddenError,
  DetectionUnauthorizedError,
  type Event,
  type Filter,
  type PageAnchor,
  type PageInfo,
  type PageSize,
  searchEventsAtAnchor,
} from "@/lib/detection";
import {
  ReviewForbiddenError,
  ReviewInvalidArgumentError,
  ReviewUnknownGraphQLError,
} from "@/lib/review/errors";

export interface RunEventQueryOk {
  ok: true;
  /**
   * REview serializes 64-bit counts as strings to preserve precision
   * (see `StringNumberScalar`). The client displays it verbatim.
   */
  totalCount: string;
  /** First-page event nodes for the result list. */
  events: Event[];
  /**
   * Per-edge REview cursor. Parallel to `events`: `eventKeys[i]` is
   * the cursor for `events[i]`. Relay-style connections guarantee
   * cursor uniqueness *within* a single page, so the client uses
   * this value as the row-key component that disambiguates two
   * byte-identical events in the same slice. The schema only
   * documents this as "a cursor for use in pagination", not as a
   * stable per-event identity across queries — so the shell
   * additionally composes it with a committed-query epoch before
   * keying rows, and does not rely on cursor equality to revalidate
   * Quick peek across committed transitions.
   */
  eventKeys: string[];
  pageInfo: PageInfo;
}

export interface RunEventQueryErr {
  ok: false;
  /**
   * `forbidden` covers the unauthorized-for-Detection case
   * (`DetectionUnauthorizedError`: caller lacks `detection:read`).
   * `forbidden-customer-scope` is the typed translation of
   * `DetectionForbiddenError` — the inbound `Filter` references a
   * customer ID the caller cannot access (#384's BFF intersection
   * check) **or** the caller's effective customer scope is empty
   * (Reviewer Round 2: empty-scope rejections flow through the
   * customer-scope gate too, since the actionable failure is "no
   * customers in scope", not "no Detection access at all"). Kept
   * distinct so the route layer / UI can render an actionable message
   * ("drop the offending IDs and retry", or "no customer access")
   * instead of the generic Detection-access denial.
   *
   * `forbidden-sensor-scope` (#278) is the typed translation of a
   * review-side `Forbidden` raised by `eventList` against a `sensors`
   * argument that carries a `nodeId` outside the caller's customer
   * scope — the path review-web 0.33.0 introduced for tampered URLs,
   * stale saved filters, and mid-session scope changes. The classifier
   * keys off `filter.input.sensors` being non-empty when the typed
   * `ReviewForbiddenError` surfaces, because review's response itself
   * does not carry a structured cause and the customer-scope leg has
   * already been ruled out in-process by `validateFilterScope` (which
   * throws `DetectionForbiddenError` before any review round-trip).
   * The shell uses {@link unavailableSensorIds} to render a "selection
   * no longer accessible" affordance and offer a one-click drop / refresh.
   */
  code:
    | "unauthenticated"
    | "forbidden"
    | "forbidden-customer-scope"
    | "forbidden-sensor-scope"
    | "invalid-input"
    | "server-error";
  /**
   * Populated only when {@link code} is `"forbidden-sensor-scope"`. Carries
   * the `sensors` argument from the rejected dispatch so the shell can
   * resolve each entry to its cached `name` (= `hostFqdn`) and render
   * the selection-no-longer-accessible affordance with a name-aware
   * message. IDs the cache cannot resolve fall back to id / count copy
   * — URL-tampered or stale-share-link IDs that were never in the
   * cache cannot be name-resolved without an extra fetch, which is
   * out of scope here.
   */
  unavailableSensorIds?: readonly string[];
}

export type RunEventQueryResult = RunEventQueryOk | RunEventQueryErr;

export interface RunEventQueryOptions {
  /**
   * Page size + cursor anchor for the requested slice. When omitted
   * the action falls back to the default page size at the head of
   * the connection — the shape a fresh Apply / Refresh produces.
   */
  pageSize?: PageSize;
  anchor?: PageAnchor;
  /**
   * Most-recent known `EventConnection.totalCount`. Threaded into
   * `searchEventsAtAnchor` so a `tail` anchor can request exactly the
   * final partial page (`last: totalCount % pageSize`) instead of a
   * straddling `last: pageSize` window. Optional — the shell has
   * this on any paginator click after the first query; pre-first
   * callers pass `null` and let the action fall back to
   * `last: pageSize`. A drifted value is self-correcting:
   * `searchEventsAtAnchor` re-queries with the freshly returned
   * total when the first response implies a different `last`.
   */
  totalCount?: string | null;
}

/**
 * Client-callable wrapper around `searchEvents` for the filter
 * drawer and the result list. Returns the page's nodes plus total
 * count and page info so the shell can render rows, the paginator,
 * and a count summary in one round-trip. Authorization checks live
 * inside `searchEvents` via `buildDispatchContext`; here we only
 * resolve the session and translate known error shapes into a typed
 * discriminated union so the client can render an error message
 * without losing the Error-class details over the RSC boundary.
 */
export async function runEventQuery(
  filter: Filter,
  options: RunEventQueryOptions = {},
): Promise<RunEventQueryResult> {
  const session = await getCurrentSession();
  if (!session) {
    return { ok: false, code: "unauthenticated" };
  }

  const anchor: PageAnchor = options.anchor ?? { kind: "head" };
  const pageSize: PageSize = options.pageSize ?? 50;
  const totalCount: string | null = options.totalCount ?? null;

  try {
    const connection = await searchEventsAtAnchor(
      session,
      filter,
      anchor,
      pageSize,
      totalCount,
    );
    return {
      ok: true,
      totalCount: connection.totalCount,
      events: connection.nodes,
      // Relay-style connections emit `edges` and `nodes` in parallel
      // order. Within a single connection the cursor is unique
      // (pagination requires it) which is enough to disambiguate two
      // byte-identical rows inside one slice — but the schema does
      // not promise stability across different queries, so the
      // client composes it with a committed-query epoch before
      // keying rows.
      eventKeys: connection.edges.map((edge) => edge.cursor),
      pageInfo: connection.pageInfo,
    };
  } catch (err) {
    if (err instanceof DetectionForbiddenError) {
      return { ok: false, code: "forbidden-customer-scope" };
    }
    if (err instanceof DetectionUnauthorizedError) {
      return { ok: false, code: "forbidden" };
    }
    // #405 I: review's GraphQL-layer denials must surface as their
    // typed code, not as a generic `server-error` — operators must be
    // able to tell "review denied this dispatch" from "the BFF crashed
    // for an unknown reason". `ReviewInvalidArgumentError` likewise
    // surfaces as a structured `invalid-input` so the shell can
    // prompt a refresh / corrective action rather than a generic
    // banner. `ReviewUnknownGraphQLError` (review answered with an
    // unrecognised code) deliberately re-throws past the
    // `server-error` fallback per the security guardrail (Reviewer
    // Round 2 P1) — a future review-side error code we don't
    // classify must not be silently masked as a generic graceful
    // state. Plain `Error`s (transport drops, BFF bugs) still fall
    // through to `server-error`.
    if (err instanceof ReviewForbiddenError) {
      // #278: distinguish "sensor selection no longer accessible" from
      // generic forbidden. Review's GraphQL response carries no
      // structured cause, but `DetectionForbiddenError` already
      // captured the customer-scope leg before any review round-trip,
      // so a `ReviewForbiddenError` reaching here with a non-empty
      // `sensors` filter is the new review-web 0.33.0 sensor-out-of-
      // scope rejection. The shell renders an affordance keyed off
      // {@link RunEventQueryErr.unavailableSensorIds}.
      const sensors =
        filter.mode === "structured" ? (filter.input.sensors ?? []) : [];
      if (sensors.length > 0) {
        return {
          ok: false,
          code: "forbidden-sensor-scope",
          unavailableSensorIds: sensors,
        };
      }
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
