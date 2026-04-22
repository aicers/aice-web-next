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

import { DetectionUnauthorizedError } from "./errors";
import { type Filter, toEventListFilterInput } from "./filter";
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

interface DispatchContext {
  role: string;
  customerIds: number[];
  filter: EventListFilterInput;
}

/**
 * Verify `detection:read`, resolve the caller's customer scope into
 * an explicit list, and normalize the filter for dispatch. Runs
 * **before** every REview request so unauthorized callers or callers
 * with no accessible customers are rejected without any network
 * traffic to REview.
 *
 * Scope is always materialized into a concrete `customer_ids` list
 * before it reaches the Context JWT — including for callers with
 * `customers:access-all`, who get every registered customer. REview
 * applies customer scoping from that claim set and does not re-derive
 * it from role text, so the BFF carries the explicit list rather than
 * relying on the consumer's interpretation of an omitted claim.
 *
 * An empty resolved scope is rejected as a misconfiguration — no
 * Detection query can succeed against it, so a silent empty result
 * would be indistinguishable from a legitimately-empty page.
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

  const customerIds = await resolveEffectiveCustomerIds(
    session.accountId,
    session.roles,
  );
  if (customerIds.length === 0) {
    throw new DetectionUnauthorizedError(
      "Caller has no assigned customers; Detection requires a customer scope.",
    );
  }

  return {
    role: session.roles[0],
    customerIds,
    filter: toEventListFilterInput(filter),
  };
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
): Promise<EventConnection> {
  const ctx = await buildDispatchContext(session, filter);
  const data = await graphqlRequest<EventListResult, EventListVariables>(
    EVENT_LIST_QUERY,
    {
      filter: ctx.filter,
      first: args.first ?? null,
      after: args.after ?? null,
      last: args.last ?? null,
      before: args.before ?? null,
    },
    { role: ctx.role, customerIds: ctx.customerIds },
  );
  return data.eventList;
}

async function dispatchCounter<TPayload>(
  session: AuthSession,
  filter: Filter,
  first: number,
  document: DocumentNode,
  extract: (data: Record<string, TPayload>) => TPayload,
): Promise<TPayload> {
  const ctx = await buildDispatchContext(session, filter);
  const data = await graphqlRequest<Record<string, TPayload>, CounterVariables>(
    document,
    { filter: ctx.filter, first },
    { role: ctx.role, customerIds: ctx.customerIds },
  );
  return extract(data);
}

export async function countEventsByCategory(
  session: AuthSession,
  filter: Filter,
  first: number,
): Promise<U8EventCounter> {
  return dispatchCounter<U8EventCounter>(
    session,
    filter,
    first,
    EVENT_COUNTS_BY_CATEGORY_QUERY,
    (d) => (d as unknown as EventCountsByCategoryResult).eventCountsByCategory,
  );
}

export async function countEventsByLevel(
  session: AuthSession,
  filter: Filter,
  first: number,
): Promise<U8EventCounter> {
  return dispatchCounter<U8EventCounter>(
    session,
    filter,
    first,
    EVENT_COUNTS_BY_LEVEL_QUERY,
    (d) => (d as unknown as EventCountsByLevelResult).eventCountsByLevel,
  );
}

export async function countEventsByCountry(
  session: AuthSession,
  filter: Filter,
  first: number,
): Promise<StringEventCounter> {
  return dispatchCounter<StringEventCounter>(
    session,
    filter,
    first,
    EVENT_COUNTS_BY_COUNTRY_QUERY,
    (d) => (d as unknown as EventCountsByCountryResult).eventCountsByCountry,
  );
}

export async function countEventsByKind(
  session: AuthSession,
  filter: Filter,
  first: number,
): Promise<StringEventCounter> {
  return dispatchCounter<StringEventCounter>(
    session,
    filter,
    first,
    EVENT_COUNTS_BY_KIND_QUERY,
    (d) => (d as unknown as EventCountsByKindResult).eventCountsByKind,
  );
}

export async function countEventsByIpAddress(
  session: AuthSession,
  filter: Filter,
  first: number,
): Promise<StringEventCounter> {
  return dispatchCounter<StringEventCounter>(
    session,
    filter,
    first,
    EVENT_COUNTS_BY_IP_ADDRESS_QUERY,
    (d) =>
      (d as unknown as EventCountsByIpAddressResult).eventCountsByIpAddress,
  );
}

export async function countEventsByOriginatorIpAddress(
  session: AuthSession,
  filter: Filter,
  first: number,
): Promise<StringEventCounter> {
  return dispatchCounter<StringEventCounter>(
    session,
    filter,
    first,
    EVENT_COUNTS_BY_ORIGINATOR_IP_ADDRESS_QUERY,
    (d) =>
      (d as unknown as EventCountsByOriginatorIpAddressResult)
        .eventCountsByOriginatorIpAddress,
  );
}

export async function countEventsByResponderIpAddress(
  session: AuthSession,
  filter: Filter,
  first: number,
): Promise<StringEventCounter> {
  return dispatchCounter<StringEventCounter>(
    session,
    filter,
    first,
    EVENT_COUNTS_BY_RESPONDER_IP_ADDRESS_QUERY,
    (d) =>
      (d as unknown as EventCountsByResponderIpAddressResult)
        .eventCountsByResponderIpAddress,
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
 * Build the tight `EventListFilterInput` for a decoded locator.
 * Exposed for tests and for the page component, which logs the
 * filter it will dispatch for debuggability.
 */
export function locatorToEventListFilter(
  locator: EventLocator,
): EventListFilterInput {
  return {
    start: locator.time,
    end: locator.time,
    source: locator.origAddr,
    destination: locator.respAddr,
    kinds: [locator.kind],
    levels: [THREAT_LEVEL_TO_NUMBER[locator.level]],
  };
}

export async function fetchEventByLocator(
  session: AuthSession,
  locator: EventLocator,
): Promise<EventDetailResolution> {
  const ctx = await buildDispatchContext(session, {
    mode: "structured",
    input: locatorToEventListFilter(locator),
  });
  const data = await graphqlRequest<EventDetailResult, EventDetailVariables>(
    EVENT_DETAIL_QUERY,
    { filter: ctx.filter },
    { role: ctx.role, customerIds: ctx.customerIds },
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
 * the query fails — IP enrichment is a best-effort decoration.
 */
export async function lookupIpLocation(
  session: AuthSession,
  address: string,
): Promise<IpLocationResult["ipLocation"]> {
  const ctx = await buildDispatchContext(session, {
    mode: "structured",
    input: {},
  });
  try {
    const data = await graphqlRequest<IpLocationResult, IpLocationVariables>(
      IP_LOCATION_QUERY,
      { address },
      { role: ctx.role, customerIds: ctx.customerIds },
    );
    return data.ipLocation;
  } catch {
    return null;
  }
}

export async function eventFrequencySeries(
  session: AuthSession,
  filter: Filter,
  period: number,
): Promise<number[]> {
  const ctx = await buildDispatchContext(session, filter);
  const data = await graphqlRequest<
    EventFrequencySeriesResult,
    FrequencySeriesVariables
  >(
    EVENT_FREQUENCY_SERIES_QUERY,
    { filter: ctx.filter, period },
    { role: ctx.role, customerIds: ctx.customerIds },
  );
  return data.eventFrequencySeries;
}
