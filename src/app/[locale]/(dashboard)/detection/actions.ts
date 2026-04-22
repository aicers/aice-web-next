"use server";

import { getCurrentSession } from "@/lib/auth/session";
import {
  DetectionUnauthorizedError,
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
}

export interface RunEventQueryErr {
  ok: false;
  code: "unauthenticated" | "forbidden" | "server-error";
}

export type RunEventQueryResult = RunEventQueryOk | RunEventQueryErr;

/**
 * Client-callable wrapper around `searchEvents` for the filter
 * drawer. Only the `totalCount` is returned in this phase — the
 * result list UI lands later. Authorization checks live inside
 * `searchEvents` via `buildDispatchContext`; here we only resolve
 * the session and translate known error shapes into a typed
 * discriminated union so the client can render an error message
 * without losing the Error-class details over the RSC boundary.
 */
export async function runEventQuery(
  filter: Filter,
): Promise<RunEventQueryResult> {
  const session = await getCurrentSession();
  if (!session) {
    return { ok: false, code: "unauthenticated" };
  }

  try {
    const connection = await searchEvents(session, filter, { first: 1 });
    return { ok: true, totalCount: connection.totalCount };
  } catch (err) {
    if (err instanceof DetectionUnauthorizedError) {
      return { ok: false, code: "forbidden" };
    }
    return { ok: false, code: "server-error" };
  }
}
