"use server";

import { getCurrentSession } from "@/lib/auth/session";
import {
  DetectionUnauthorizedError,
  type Event,
  type Filter,
  searchEvents,
} from "@/lib/detection";

export interface RunEventQueryOk {
  ok: true;
  /**
   * REview serializes 64-bit counts as strings to preserve precision
   * (see `StringNumberScalar`). The client displays it verbatim.
   */
  totalCount: string;
  events: Event[];
  /**
   * Parallel-indexed Relay cursors (one per event). Used as the stable
   * React key in the list so reconciliation doesn't collapse distinct
   * events that share `__typename|time|sensor|addressing`.
   */
  cursors: (string | null)[];
  /** ISO-8601 UTC timestamp of the fetch, for "Updated …" display. */
  fetchedAt: string;
}

export interface RunEventQueryErr {
  ok: false;
  code: "unauthenticated" | "forbidden" | "server-error";
}

export type RunEventQueryResult = RunEventQueryOk | RunEventQueryErr;

/**
 * Default page size for the Detection result list. v1 ships without
 * pagination controls (explicit non-goal for Phase Detection-9), so
 * the first page is enough to populate the hero list.
 */
const EVENT_LIST_PAGE_SIZE = 50;

/**
 * Client-callable wrapper around `searchEvents` for the Detection
 * page. Returns the first page of events plus the BigInt-safe total
 * count so the shell can render the hero result list. Authorization
 * checks live inside `searchEvents` via `buildDispatchContext`; here
 * we only resolve the session and translate known error shapes into
 * a typed discriminated union so the client can render an error
 * message without losing the Error-class details over the RSC
 * boundary.
 */
export async function runEventQuery(
  filter: Filter,
): Promise<RunEventQueryResult> {
  const session = await getCurrentSession();
  if (!session) {
    return { ok: false, code: "unauthenticated" };
  }

  try {
    const connection = await searchEvents(session, filter, {
      first: EVENT_LIST_PAGE_SIZE,
    });
    return {
      ok: true,
      totalCount: connection.totalCount,
      events: connection.edges.map((edge) => edge.node),
      cursors: connection.edges.map((edge) => edge.cursor ?? null),
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    if (err instanceof DetectionUnauthorizedError) {
      return { ok: false, code: "forbidden" };
    }
    return { ok: false, code: "server-error" };
  }
}
