"use server";

import { getCurrentSession } from "@/lib/auth/session";

import { TriageUnauthorizedError } from "./errors";
import {
  fetchTier2DimensionWithSession,
  type Tier2FetchInput,
  type Tier2FetchResult,
} from "./tier2-fetch-impl";

/**
 * Server action: fetch a Tier 2 dimension result for the menu pivot.
 * Permission and scope checks live inside
 * {@link fetchTier2DimensionWithSession} so a Tier 2 click stays
 * inside the `triage:read` boundary and never implicitly requires
 * `detection:read`.
 *
 * Implementation lives in `tier2-fetch-impl.ts` so the test suite can
 * exercise the dispatch logic with a synthetic {@link AuthSession}
 * without crossing the `"use server"` boundary.
 */
export async function fetchTier2Dimension(
  input: Tier2FetchInput,
): Promise<Tier2FetchResult> {
  const session = await getCurrentSession();
  if (!session) {
    throw new TriageUnauthorizedError(
      "No active session; Tier 2 fetch requires triage:read.",
    );
  }
  return fetchTier2DimensionWithSession(session, input);
}
