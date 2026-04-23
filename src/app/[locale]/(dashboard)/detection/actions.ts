"use server";

import { getCurrentSession } from "@/lib/auth/session";
import {
  DetectionUnauthorizedError,
  type Event,
  type Filter,
  type PageInfo,
  searchEvents,
} from "@/lib/detection";
import { DEFAULT_EVENT_LIST_PAGE_SIZE } from "@/lib/detection/page-size";

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
  code: "unauthenticated" | "forbidden" | "server-error";
}

export type RunEventQueryResult = RunEventQueryOk | RunEventQueryErr;

/**
 * Client-callable wrapper around `searchEvents` for the filter
 * drawer and the result list. Returns the first-page nodes plus
 * total count and page info so the shell can render rows and a
 * count summary in one round-trip. Authorization checks live inside
 * `searchEvents` via `buildDispatchContext`; here we only resolve
 * the session and translate known error shapes into a typed
 * discriminated union so the client can render an error message
 * without losing the Error-class details over the RSC boundary.
 */
export async function runEventQuery(
  filter: Filter,
  pageSize: number = DEFAULT_EVENT_LIST_PAGE_SIZE,
): Promise<RunEventQueryResult> {
  const session = await getCurrentSession();
  if (!session) {
    return { ok: false, code: "unauthenticated" };
  }

  try {
    const connection = await searchEvents(session, filter, { first: pageSize });
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
    if (err instanceof DetectionUnauthorizedError) {
      return { ok: false, code: "forbidden" };
    }
    return { ok: false, code: "server-error" };
  }
}
