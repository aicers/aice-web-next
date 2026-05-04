import "server-only";

import type { DocumentNode } from "graphql";

import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import type { AuthSession } from "@/lib/auth/jwt";
import { hasPermission } from "@/lib/auth/permissions";
import {
  type EventLocator,
  THREAT_LEVEL_TO_NUMBER,
} from "@/lib/events/event-locator";
import { graphqlRequest } from "@/lib/graphql/client";
import { withReviewErrorMapping } from "@/lib/review/error-mapping";
import {
  ReviewForbiddenError,
  ReviewInvalidArgumentError,
  ReviewUnknownGraphQLError,
} from "@/lib/review/errors";

import { DetectionForbiddenError, DetectionUnauthorizedError } from "./errors";
import { type Filter, toEventListFilterInput } from "./filter";
import { validateFilterScope } from "./filter-customer-scope";
import {
  type PageAnchor,
  type PageSize,
  searchArgsForAnchor,
} from "./pagination";
import {
  EVENT_COUNTS_BY_CATEGORY_QUERY,
  EVENT_COUNTS_BY_COUNTRY_QUERY,
  EVENT_COUNTS_BY_IP_ADDRESS_QUERY,
  EVENT_COUNTS_BY_KIND_QUERY,
  EVENT_COUNTS_BY_LEVEL_QUERY,
  EVENT_COUNTS_BY_ORIGINATOR_IP_ADDRESS_QUERY,
  EVENT_COUNTS_BY_RESPONDER_IP_ADDRESS_QUERY,
  EVENT_DETAIL_QUERY,
  EVENT_FREQUENCY_SERIES_QUERY,
  EVENT_LIST_QUERY,
  IP_LOCATION_QUERY,
} from "./queries";
import type {
  Event,
  EventConnection,
  EventCountsByCategoryResult,
  EventCountsByCountryResult,
  EventCountsByIpAddressResult,
  EventCountsByKindResult,
  EventCountsByLevelResult,
  EventCountsByOriginatorIpAddressResult,
  EventCountsByResponderIpAddressResult,
  EventDetailResult,
  EventFrequencySeriesResult,
  EventListFilterInput,
  EventListResult,
  IpLocationResult,
  StringEventCounter,
  U8EventCounter,
} from "./types";

// ── Permission / customer scope ──────────────────────────────────

const DETECTION_READ = "detection:read";
const CUSTOMERS_ACCESS_ALL = "customers:access-all";
const SYSTEM_ADMINISTRATOR = "System Administrator";

interface DispatchContext {
  role: string;
  customerIds: number[];
  /**
   * Whether the caller holds `customers:access-all`, regardless of how
   * many rows happen to be in the local `customers` table. Mirrors
   * Node's `DispatchContext.hasGlobalScope` so a fresh-install admin
   * (no `customers` rows yet) is not blocked by the empty-scope gate.
   */
  hasGlobalScope: boolean;
  filter: EventListFilterInput;
}

/**
 * Verify `detection:read`, resolve the caller's customer scope into
 * an explicit list, and normalize the filter for dispatch. Runs
 * **before** every REview request so unauthorized callers or callers
 * with no accessible customers are rejected without any network
 * traffic to REview.
 *
 * `customerIds` carries the materialized scope used for in-process
 * defense-in-depth checks (`validateFilterScope` against
 * `filter.input.customers`). The Context JWT shape is *separately*
 * decided in {@link jwtCustomerIdsForDetection}: review's
 * `validate_context_jwt` accepts `customer_ids = None` only for
 * `Role::SystemAdministrator`, so the JWT omits the field for the
 * bootstrap admin and ships the materialized list for every other
 * caller.
 *
 * Empty-scope handling differentiates two cases:
 *
 *   - `hasGlobalScope === true` (caller holds `customers:access-all`):
 *     **do not block** even when the local `customers` table is
 *     empty. A fresh install with no `customers` rows still has the
 *     bootstrap System Administrator, who legitimately needs to
 *     reach Detection so review's own customer can be enumerated.
 *     Review accepts `customer_ids = None` for the SysAdmin role, so
 *     the dispatch succeeds end-to-end.
 *   - `hasGlobalScope === false` and `customerIds.length === 0`:
 *     reject through the customer-scope gate
 *     (`DetectionForbiddenError` → `forbidden-customer-scope`). The
 *     caller does hold `detection:read`, so "no Detection access at
 *     all" is a misleading classification — the actionable problem
 *     is that the caller has no customers in scope, same family as a
 *     crafted filter that references customers outside scope. #384's
 *     acceptance treats empty-scope sessions as part of the same
 *     authoritative customer-scope gate. A silent empty result would
 *     also be indistinguishable from a legitimately-empty page, so
 *     the rejection happens before any REview round-trip.
 *
 * The caller's customer scope travels in the Context JWT (see
 * `graphqlRequest`), not in `filter.customers`. The filter's
 * `customers` field stays part of the query surface so callers can
 * narrow to a subset of their allowed scope; REview intersects the
 * JWT-carried scope with whatever the filter asks for.
 */
async function buildDispatchContext(
  session: AuthSession,
  filter: Filter,
): Promise<DispatchContext> {
  if (!(await hasPermission(session.roles, DETECTION_READ))) {
    throw new DetectionUnauthorizedError(
      "Caller lacks the detection:read permission.",
    );
  }

  const hasGlobalScope = await hasPermission(
    session.roles,
    CUSTOMERS_ACCESS_ALL,
  );
  const customerIds = await resolveEffectiveCustomerIds(
    session.accountId,
    session.roles,
  );
  if (!hasGlobalScope && customerIds.length === 0) {
    throw new DetectionForbiddenError(
      "Caller has no assigned customers; Detection requires a customer scope.",
    );
  }

  // BFF intersection check (#384). Reject before any REview round-
  // trip when `filter.input.customers` references IDs outside the
  // caller's effective scope. Throws `DetectionForbiddenError`; the
  // route layer maps it to the same forbidden response code as the
  // unauthorized branch above so neither path leaks a partial result.
  //
  // The check intentionally only runs for non-global-scope callers
  // (#405 P2). The local `customers` table is the BFF's
  // *materialized* view of review's customer set, used to enforce
  // per-account scope. An admin with `customers:access-all` is
  // logically `customer_ids = None` (review's "all customers" wire
  // semantics, see {@link jwtCustomerIdsForDetection}) — running
  // them through an intersection against the local list would
  // incorrectly reject filters that reference legitimate review
  // customer IDs missing from the local table (the most common
  // reproduction is a fresh install where the bootstrap admin
  // pivots into a review customer before BFF sync runs). The admin
  // path delegates filter validation to review itself: if the
  // operator types a non-existent customer ID, review returns an
  // empty connection rather than 500. Non-admin callers keep the
  // BFF gate as the authoritative scope check — their JWT carries
  // a finite materialized list and the intersection is meaningful.
  if (!hasGlobalScope) {
    validateFilterScope(filter, customerIds);
  }

  return {
    role: session.roles[0],
    customerIds,
    hasGlobalScope,
    filter: toEventListFilterInput(filter),
  };
}

/**
 * Derive the `customer_ids` claim that should ride on the Context
 * JWT for a Detection dispatch. Mirrors Node's `jwtCustomerIdsFor`:
 * review's `validate_context_jwt` accepts `customer_ids = None` only
 * for `Role::SystemAdministrator`, so the JWT omits the field for
 * the bootstrap admin and ships the materialized list for every
 * other caller — including custom roles that grant
 * `customers:access-all`.
 */
function jwtCustomerIdsForDetection(
  ctx: Pick<DispatchContext, "role" | "customerIds">,
): number[] | undefined {
  return ctx.role === SYSTEM_ADMINISTRATOR ? undefined : ctx.customerIds;
}

// ── Variable shapes (match the `.graphql` operations one-for-one) ──

interface EventListVariables extends Record<string, unknown> {
  filter: EventListFilterInput;
  first: number | null;
  after: string | null;
  last: number | null;
  before: string | null;
}

interface CounterVariables extends Record<string, unknown> {
  filter: EventListFilterInput;
  first: number;
}

interface FrequencySeriesVariables extends Record<string, unknown> {
  filter: EventListFilterInput;
  period: number;
}

// ── Pagination / count argument types ────────────────────────────

export interface SearchEventsArgs {
  first?: number;
  after?: string;
  last?: number;
  before?: string;
}

// ── Server actions ───────────────────────────────────────────────

export async function searchEvents(
  session: AuthSession,
  filter: Filter,
  args: SearchEventsArgs = {},
  signal?: AbortSignal,
): Promise<EventConnection> {
  const ctx = await buildDispatchContext(session, filter);
  const data = await withReviewErrorMapping(
    graphqlRequest<EventListResult, EventListVariables>(
      EVENT_LIST_QUERY,
      {
        filter: ctx.filter,
        first: args.first ?? null,
        after: args.after ?? null,
        last: args.last ?? null,
        before: args.before ?? null,
      },
      { role: ctx.role, customerIds: jwtCustomerIdsForDetection(ctx) },
      signal,
    ),
  );
  return data.eventList;
}

/** Maximum number of corrective re-queries for a drifting `tail`. */
const TAIL_DRIFT_MAX_CORRECTIONS = 2;

/**
 * Fetch an event page at a cursor anchor with total-drift correction
 * on `tail` windows.
 *
 * Relay's `last: N` returns the last N rows of the connection, not
 * "the Nth-from-end page", so {@link searchArgsForAnchor} narrows
 * `last` to `totalCount % pageSize` to match the labeled final page.
 * That narrowing relies on an accurate `totalCount`: if the caller's
 * cached total is stale (new events arrived between navigations),
 * REview still returns the tail of the *current* connection, but
 * that window straddles a page boundary and the UI label lies.
 *
 * This helper re-queries with the total reported by the first
 * response; a tight correction loop (capped at
 * {@link TAIL_DRIFT_MAX_CORRECTIONS}) converges in steady state and
 * bounds worst-case traffic under pathological drift. Non-tail
 * anchors (head / after / before) sidestep the loop — their `first`
 * / `last` argument is independent of `totalCount`.
 */
export async function searchEventsAtAnchor(
  session: AuthSession,
  filter: Filter,
  anchor: PageAnchor,
  pageSize: PageSize,
  knownTotal: string | null = null,
  signal?: AbortSignal,
): Promise<EventConnection> {
  let args = searchArgsForAnchor(anchor, pageSize, knownTotal);
  let connection = await searchEvents(session, filter, args, signal);
  if (anchor.kind !== "tail") return connection;
  for (let attempt = 0; attempt < TAIL_DRIFT_MAX_CORRECTIONS; attempt++) {
    const corrected = searchArgsForAnchor(
      anchor,
      pageSize,
      connection.totalCount,
    );
    if (corrected.last === args.last) break;
    args = corrected;
    connection = await searchEvents(session, filter, args, signal);
  }
  return connection;
}

async function dispatchCounter<TPayload>(
  session: AuthSession,
  filter: Filter,
  first: number,
  document: DocumentNode,
  extract: (data: Record<string, TPayload>) => TPayload,
  signal?: AbortSignal,
): Promise<TPayload> {
  const ctx = await buildDispatchContext(session, filter);
  const data = await withReviewErrorMapping(
    graphqlRequest<Record<string, TPayload>, CounterVariables>(
      document,
      { filter: ctx.filter, first },
      { role: ctx.role, customerIds: jwtCustomerIdsForDetection(ctx) },
      signal,
    ),
  );
  return extract(data);
}

export async function countEventsByCategory(
  session: AuthSession,
  filter: Filter,
  first: number,
  signal?: AbortSignal,
): Promise<U8EventCounter> {
  return dispatchCounter<U8EventCounter>(
    session,
    filter,
    first,
    EVENT_COUNTS_BY_CATEGORY_QUERY,
    (d) => (d as unknown as EventCountsByCategoryResult).eventCountsByCategory,
    signal,
  );
}

export async function countEventsByLevel(
  session: AuthSession,
  filter: Filter,
  first: number,
  signal?: AbortSignal,
): Promise<U8EventCounter> {
  return dispatchCounter<U8EventCounter>(
    session,
    filter,
    first,
    EVENT_COUNTS_BY_LEVEL_QUERY,
    (d) => (d as unknown as EventCountsByLevelResult).eventCountsByLevel,
    signal,
  );
}

export async function countEventsByCountry(
  session: AuthSession,
  filter: Filter,
  first: number,
  signal?: AbortSignal,
): Promise<StringEventCounter> {
  return dispatchCounter<StringEventCounter>(
    session,
    filter,
    first,
    EVENT_COUNTS_BY_COUNTRY_QUERY,
    (d) => (d as unknown as EventCountsByCountryResult).eventCountsByCountry,
    signal,
  );
}

export async function countEventsByKind(
  session: AuthSession,
  filter: Filter,
  first: number,
  signal?: AbortSignal,
): Promise<StringEventCounter> {
  return dispatchCounter<StringEventCounter>(
    session,
    filter,
    first,
    EVENT_COUNTS_BY_KIND_QUERY,
    (d) => (d as unknown as EventCountsByKindResult).eventCountsByKind,
    signal,
  );
}

export async function countEventsByIpAddress(
  session: AuthSession,
  filter: Filter,
  first: number,
  signal?: AbortSignal,
): Promise<StringEventCounter> {
  return dispatchCounter<StringEventCounter>(
    session,
    filter,
    first,
    EVENT_COUNTS_BY_IP_ADDRESS_QUERY,
    (d) =>
      (d as unknown as EventCountsByIpAddressResult).eventCountsByIpAddress,
    signal,
  );
}

export async function countEventsByOriginatorIpAddress(
  session: AuthSession,
  filter: Filter,
  first: number,
  signal?: AbortSignal,
): Promise<StringEventCounter> {
  return dispatchCounter<StringEventCounter>(
    session,
    filter,
    first,
    EVENT_COUNTS_BY_ORIGINATOR_IP_ADDRESS_QUERY,
    (d) =>
      (d as unknown as EventCountsByOriginatorIpAddressResult)
        .eventCountsByOriginatorIpAddress,
    signal,
  );
}

export async function countEventsByResponderIpAddress(
  session: AuthSession,
  filter: Filter,
  first: number,
  signal?: AbortSignal,
): Promise<StringEventCounter> {
  return dispatchCounter<StringEventCounter>(
    session,
    filter,
    first,
    EVENT_COUNTS_BY_RESPONDER_IP_ADDRESS_QUERY,
    (d) =>
      (d as unknown as EventCountsByResponderIpAddressResult)
        .eventCountsByResponderIpAddress,
    signal,
  );
}

// ── Event detail (investigation view) ────────────────────────────
//
// Resolution semantics — see `@/lib/events/event-locator` and the
// spec in issue #291. The decoded locator is translated into a tight
// `EventListFilterInput`:
//   - `time` is used for both `start` and `end` (exact match)
//   - `origAddr` -> `source`, `respAddr` -> `destination`
//   - `kind` -> `kinds[0]`, `level` -> `levels[0]`
// Ports, proto, and sensor-name are kept in the locator for display
// and forward-compat; they do not narrow the query in v1.

export type EventDetailResolution =
  | { status: "zero" }
  | { status: "one"; event: Event; totalCount: string }
  | { status: "multiple"; event: Event; totalCount: string };

interface EventDetailVariables extends Record<string, unknown> {
  filter: EventListFilterInput;
}

interface IpLocationVariables extends Record<string, unknown> {
  address: string;
}

/**
 * Add one second to an RFC 3339 timestamp, returning a UTC ISO
 * string with millisecond precision. Used by
 * {@link locatorToEventListFilter} to widen the end bound; the
 * 1-second gap is intentionally generous so callers don't need to
 * preserve nanosecond fractions across the round-trip.
 */
function addOneSecond(timestamp: string): string {
  return new Date(Date.parse(timestamp) + 1000).toISOString();
}

/**
 * Build the tight `EventListFilterInput` for a decoded locator.
 * Exposed for tests and for the page component, which logs the
 * filter it will dispatch for debuggability.
 *
 * `end` is widened by **+1 second** because REview's `eventList`
 * treats `end` as exclusive: the half-open interval
 * `[locator.time, locator.time)` is empty and the matching event is
 * always filtered out (#424). Disambiguation when more than one
 * event lands inside the 1-second window is handled by the existing
 * `status: "multiple"` branch in {@link fetchEventByLocator}. This
 * is a workaround for REview lacking a single-event lookup API
 * (aicers/review-web#841); when that API ships the widening must be
 * removed and replaced with the direct lookup.
 */
export function locatorToEventListFilter(
  locator: EventLocator,
): EventListFilterInput {
  return {
    start: locator.time,
    end: addOneSecond(locator.time),
    source: locator.origAddr,
    destination: locator.respAddr,
    kinds: [locator.kind],
    levels: [THREAT_LEVEL_TO_NUMBER[locator.level]],
  };
}

export async function fetchEventByLocator(
  session: AuthSession,
  locator: EventLocator,
  signal?: AbortSignal,
): Promise<EventDetailResolution> {
  const ctx = await buildDispatchContext(session, {
    mode: "structured",
    input: locatorToEventListFilter(locator),
  });
  const data = await withReviewErrorMapping(
    graphqlRequest<EventDetailResult, EventDetailVariables>(
      EVENT_DETAIL_QUERY,
      { filter: ctx.filter },
      { role: ctx.role, customerIds: jwtCustomerIdsForDetection(ctx) },
      signal,
    ),
  );
  const nodes = data.eventList.nodes;
  const totalCount = data.eventList.totalCount;
  if (nodes.length === 0) return { status: "zero" };
  if (nodes.length === 1) {
    return { status: "one", event: nodes[0], totalCount };
  }
  return { status: "multiple", event: nodes[0], totalCount };
}

/**
 * Look up geolocation for a single IP address. Returns `null` when
 * REview has no entry (the `IpLocation` return is nullable), or when
 * the query fails for a transient / unknown reason — IP enrichment
 * is a best-effort decoration.
 *
 * Typed review denials ({@link ReviewForbiddenError} /
 * {@link ReviewInvalidArgumentError}) are intentionally re-thrown
 * rather than collapsed to `null`: per #405's security guardrail,
 * Forbidden must not be silently swallowed as "no data". Callers
 * that already render an explicit access-denied state (Investigation
 * page, endpoint enrichment) propagate the rejection upward; the
 * legacy "best-effort decoration" contract still applies for
 * transient transport failures and ordinary unknown errors.
 *
 * Reviewer Round 2 P1: an unrecognised review GraphQL error
 * ({@link ReviewUnknownGraphQLError}) likewise re-throws rather
 * than collapsing to `null` — masking a new review-side error code
 * as "no enrichment data" would defeat the same guardrail.
 */
export async function lookupIpLocation(
  session: AuthSession,
  address: string,
  signal?: AbortSignal,
): Promise<IpLocationResult["ipLocation"]> {
  const ctx = await buildDispatchContext(session, {
    mode: "structured",
    input: {},
  });
  try {
    const data = await withReviewErrorMapping(
      graphqlRequest<IpLocationResult, IpLocationVariables>(
        IP_LOCATION_QUERY,
        { address },
        { role: ctx.role, customerIds: jwtCustomerIdsForDetection(ctx) },
        signal,
      ),
    );
    return data.ipLocation;
  } catch (err) {
    if (
      err instanceof ReviewForbiddenError ||
      err instanceof ReviewInvalidArgumentError ||
      err instanceof ReviewUnknownGraphQLError
    ) {
      throw err;
    }
    return null;
  }
}

export async function eventFrequencySeries(
  session: AuthSession,
  filter: Filter,
  period: number,
  signal?: AbortSignal,
): Promise<number[]> {
  const ctx = await buildDispatchContext(session, filter);
  const data = await withReviewErrorMapping(
    graphqlRequest<EventFrequencySeriesResult, FrequencySeriesVariables>(
      EVENT_FREQUENCY_SERIES_QUERY,
      { filter: ctx.filter, period },
      { role: ctx.role, customerIds: jwtCustomerIdsForDetection(ctx) },
      signal,
    ),
  );
  return data.eventFrequencySeries;
}
