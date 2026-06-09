import "server-only";

import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import type { AuthSession } from "@/lib/auth/jwt";
import { hasPermission } from "@/lib/auth/permissions";
import { gigantoClient } from "@/lib/graphql/external-client";
import { withExternalErrorMapping } from "@/lib/node/error-mapping";

import { RECORD_DESCRIPTORS } from "./descriptors";
import { EventPermissionError } from "./errors";
import type { EventFilter } from "./filter";
import { toNetworkFilter } from "./filter";
import {
  type ConnPageArgs,
  type PageAnchor,
  type PageSize,
  pageArgsForAnchor,
} from "./pagination";
import { EVENT_SENSORS_QUERY, RAW_EVENT_QUERIES } from "./queries";
import type {
  ConnRawEventConnection,
  EventSensorsResult,
  NetworkFilterInput,
  RawEvent,
  RawEventConnection,
} from "./types";

const EVENT_READ = "event:read";
const CUSTOMERS_ACCESS_ALL = "customers:access-all";
const SYSTEM_ADMINISTRATOR = "System Administrator";

interface DispatchContext {
  role: string;
  customerIds: number[];
  /**
   * Whether the caller holds `customers:access-all`, regardless of how
   * many rows are in the local `customers` table. Mirrors Detection /
   * Node so a fresh-install admin (no `customers` rows yet) is not
   * blocked by the empty-scope gate.
   */
  hasGlobalScope: boolean;
}

/**
 * Verify `event:read` and resolve the caller's customer scope into an
 * explicit list. Runs **before** every Giganto request so unauthorized
 * callers or callers with no accessible customers are rejected without
 * any network traffic.
 *
 * Mirrors Detection's empty-scope handling: an access-all caller (in
 * particular the bootstrap System Administrator on a fresh install with
 * no `customers` rows yet) is allowed through; every other caller with
 * an empty scope is rejected.
 */
async function buildDispatchContext(
  session: AuthSession,
): Promise<DispatchContext> {
  if (!(await hasPermission(session.roles, EVENT_READ))) {
    throw new EventPermissionError("Caller lacks the event:read permission.");
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
    throw new EventPermissionError(
      "Caller has no assigned customers; the Event menu requires a customer scope.",
    );
  }

  return { role: session.roles[0], customerIds, hasGlobalScope };
}

/**
 * Derive the `customer_ids` claim for the Context JWT. Mirrors
 * Detection / Node: review-side `validate_context_jwt` accepts
 * `customer_ids = None` only for `Role::SystemAdministrator`, so the
 * JWT omits the field for the bootstrap admin and ships the
 * materialized list for every other caller.
 */
function jwtCustomerIdsForEvent(
  role: string,
  customerIds: number[],
): number[] | undefined {
  return role === SYSTEM_ADMINISTRATOR ? undefined : customerIds;
}

interface RawEventsVariables extends Record<string, unknown> {
  filter: NetworkFilterInput;
  first: number | null;
  after: string | null;
  last: number | null;
  before: string | null;
}

/**
 * Run a network raw-event search for the filter's selected record type
 * at a cursor anchor. The record type picks the `<type>RawEvents`
 * document and response key from {@link RECORD_DESCRIPTORS}; every type
 * shares the `NetworkFilter` + Relay pagination shape, so one dispatch
 * covers all 20.
 *
 * Returns `null` when the filter has no sensor selected — Giganto's
 * `NetworkFilter.sensor` is required, so the caller renders the
 * pre-query prompt instead of dispatching an invalid query.
 */
export async function searchRawEvents(
  session: AuthSession,
  filter: EventFilter,
  anchor: PageAnchor,
  pageSize: PageSize,
  signal?: AbortSignal,
): Promise<RawEventConnection<RawEvent> | null> {
  const networkFilter = toNetworkFilter(filter);
  if (networkFilter === null) return null;

  const descriptor = RECORD_DESCRIPTORS[filter.recordType];
  const ctx = await buildDispatchContext(session);
  const args: ConnPageArgs = pageArgsForAnchor(anchor, pageSize);
  const data = await withExternalErrorMapping(
    "DATA_STORE",
    gigantoClient<
      Record<string, RawEventConnection<RawEvent>>,
      RawEventsVariables
    >(
      RAW_EVENT_QUERIES[filter.recordType],
      {
        filter: networkFilter,
        first: args.first ?? null,
        after: args.after ?? null,
        last: args.last ?? null,
        before: args.before ?? null,
      },
      {
        role: ctx.role,
        customerIds: jwtCustomerIdsForEvent(ctx.role, ctx.customerIds),
      },
      signal,
    ),
  );
  return data[descriptor.responseKey];
}

/**
 * Conn-specific wrapper retained for E0 call sites and tests. Delegates
 * to {@link searchRawEvents} with the record type forced to `conn`.
 */
export async function searchConnRawEvents(
  session: AuthSession,
  filter: EventFilter,
  anchor: PageAnchor,
  pageSize: PageSize,
  signal?: AbortSignal,
): Promise<ConnRawEventConnection | null> {
  const connection = await searchRawEvents(
    session,
    { ...filter, recordType: "conn" },
    anchor,
    pageSize,
    signal,
  );
  return connection as ConnRawEventConnection | null;
}

/**
 * List the sensor ids Giganto has ingested data for. Populates the
 * single-sensor selector.
 */
export async function listEventSensors(
  session: AuthSession,
  signal?: AbortSignal,
): Promise<string[]> {
  const ctx = await buildDispatchContext(session);
  const data = await withExternalErrorMapping(
    "DATA_STORE",
    gigantoClient<EventSensorsResult>(
      EVENT_SENSORS_QUERY,
      undefined,
      {
        role: ctx.role,
        customerIds: jwtCustomerIdsForEvent(ctx.role, ctx.customerIds),
      },
      signal,
    ),
  );
  return data.sensors;
}

export { ExternalServiceUnavailableError } from "@/lib/node/errors";
// Re-export errors so callers import from one module (mirrors Node).
export { EventPermissionError } from "./errors";
