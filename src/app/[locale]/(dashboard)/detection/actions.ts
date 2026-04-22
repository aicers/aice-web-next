"use server";

import { getCurrentSession } from "@/lib/auth/session";
import {
  DetectionUnauthorizedError,
  type Event,
  type Filter,
  searchEvents,
} from "@/lib/detection";
import { DEFAULT_RESULT_PAGE_SIZE } from "./constants";

export interface RunEventQueryOk {
  ok: true;
  /**
   * REview serializes 64-bit counts as strings to preserve precision
   * (see `StringNumberScalar`). The client displays it verbatim.
   */
  totalCount: string;
  /**
   * First page of result events. Empty when `totalCount === "0"`;
   * the client renders the empty-state UI in that case.
   */
  events: Event[];
  /**
   * Per-row opaque Relay cursor, parallel-indexed to `events`. Used
   * as the stable React key so reconciliation doesn't recycle DOM
   * across distinct events when a composite key would collide (e.g.
   * host-based events with no addressing, or identical IP+port+time
   * duplicates). Entries can be `null` if a server ever drops the
   * cursor on a node; callers must fall back for those rows.
   */
  cursors: (string | null)[];
  /** Last-updated timestamp (ISO-8601 UTC) for the refresh affordance. */
  fetchedAt: string;
}

export interface RunEventQueryErr {
  ok: false;
  code: "unauthenticated" | "forbidden" | "server-error";
}

export type RunEventQueryResult = RunEventQueryOk | RunEventQueryErr;

/**
 * Client-callable wrapper around `searchEvents`. Returns the first
 * page of events plus the BigInt-safe total count so the result
 * list and header can render off a single round-trip. Authorization
 * checks live inside `searchEvents` via `buildDispatchContext`;
 * here we only resolve the session and translate known error
 * shapes into a typed discriminated union so the client can render
 * an error message without losing the `Error`-class details over
 * the RSC boundary.
 */
export async function runEventQuery(
  filter: Filter,
  pageSize: number = DEFAULT_RESULT_PAGE_SIZE,
): Promise<RunEventQueryResult> {
  const session = await getCurrentSession();
  if (!session) {
    return { ok: false, code: "unauthenticated" };
  }

  try {
    const connection = await searchEvents(session, filter, {
      first: pageSize,
    });
    // Prefer `edges` so the stable cursor travels with each node.
    // `nodes` stays as the canonical source for the row payload to
    // match the generated connection shape used elsewhere.
    const edgeNodes = connection.edges?.map((edge) => edge.node) ?? [];
    const cursors = connection.edges?.map((edge) => edge.cursor ?? null) ?? [];
    const events =
      edgeNodes.length === connection.nodes.length
        ? edgeNodes
        : connection.nodes;
    return {
      ok: true,
      totalCount: connection.totalCount,
      events,
      cursors,
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    if (err instanceof DetectionUnauthorizedError) {
      return { ok: false, code: "forbidden" };
    }
    return { ok: false, code: "server-error" };
  }
}
