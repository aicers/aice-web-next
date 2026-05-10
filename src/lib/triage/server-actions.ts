import "server-only";

import type { AuthSession } from "@/lib/auth/jwt";
import type { EventListFilterInput } from "@/lib/detection";
import { graphqlRequest } from "@/lib/graphql/client";
import { withReviewErrorMapping } from "@/lib/review/error-mapping";
import { REVIEW_MAX_PAGE_SIZE } from "@/lib/review/limits";

import { aggregateTriageEvents } from "./aggregate";
import {
  buildDispatchContext,
  jwtCustomerIdsForTriage,
} from "./dispatch-context";
import type { TriagePeriod } from "./period";
import { TRIAGE_EVENT_LIST_QUERY } from "./queries";
import {
  TRIAGE_HARD_EVENT_CAP,
  type TriageEvent,
  type TriageEventListResult,
  type TriageLoadResult,
} from "./types";

/**
 * Page size used per `eventList` round-trip while paginating to the
 * cap. Capped to {@link REVIEW_MAX_PAGE_SIZE} (100) — review 0.47.0
 * rejects `first` / `last` outside `[0, 100]` with a GraphQL-level
 * error. Tier 2 fetches share the same constant so the loader's
 * page-size story stays consistent across Tier 1 and Tier 2.
 */
const TRIAGE_PAGE_SIZE = REVIEW_MAX_PAGE_SIZE;

interface TriageEventListVariables extends Record<string, unknown> {
  filter: EventListFilterInput;
  first: number;
  after: string | null;
}

/**
 * Fetch up to {@link TRIAGE_HARD_EVENT_CAP} events for the supplied
 * period, then aggregate them into the Triage funnel + asset list.
 *
 * Cursor pagination matches Detection's contract: the first page uses
 * `after: null`; each subsequent page passes the previous response's
 * `pageInfo.endCursor`. Iteration stops on the first of:
 *   - `pageInfo.hasNextPage === false`
 *   - the accumulator reaches `TRIAGE_HARD_EVENT_CAP`
 *
 * The flag returned to the caller — `truncated` — is `true` when the
 * cap was hit AND REview reports more pages remain. A loaded slice
 * that exactly reached the cap on the final page is not "truncated"
 * because the operator did see every event in the period.
 */
export async function loadTriagePeriod(
  session: AuthSession,
  period: TriagePeriod,
  signal?: AbortSignal,
): Promise<TriageLoadResult> {
  const ctx = await buildDispatchContext(session);

  const filter: EventListFilterInput = {
    start: period.startIso,
    end: period.endIso,
  };
  const jwtCustomerIds = jwtCustomerIdsForTriage(ctx);

  const events: TriageEvent[] = [];
  let cursor: string | null = null;
  let truncated = false;
  // Bound the loop independently of `hasNextPage` so a misbehaving
  // backend can't wedge the page in an infinite fetch.
  const maxPages = Math.ceil(TRIAGE_HARD_EVENT_CAP / TRIAGE_PAGE_SIZE) + 1;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const remaining = TRIAGE_HARD_EVENT_CAP - events.length;
    if (remaining <= 0) break;
    const first = Math.min(TRIAGE_PAGE_SIZE, remaining);
    const data: TriageEventListResult = await withReviewErrorMapping(
      graphqlRequest<TriageEventListResult, TriageEventListVariables>(
        TRIAGE_EVENT_LIST_QUERY,
        { filter, first, after: cursor },
        { role: ctx.role, customerIds: jwtCustomerIds },
        signal,
      ),
    );
    const page = data.eventList;
    events.push(...page.nodes);
    if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) {
      break;
    }
    cursor = page.pageInfo.endCursor;
    if (events.length >= TRIAGE_HARD_EVENT_CAP) {
      truncated = true;
      break;
    }
  }

  return aggregateTriageEvents(events, truncated);
}
