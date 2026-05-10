import "server-only";

import type { AuthSession } from "@/lib/auth/jwt";
import type { EventListFilterInput } from "@/lib/detection";
import { graphqlRequest } from "@/lib/graphql/client";
import { withReviewErrorMapping } from "@/lib/review/error-mapping";
import { REVIEW_MAX_PAGE_SIZE } from "@/lib/review/limits";

import {
  buildDispatchContext,
  jwtCustomerIdsForTriage,
} from "./dispatch-context";
import { TRIAGE_EVENT_LIST_QUERY } from "./queries";
import { buildTier2Filter, type Tier2Dimension } from "./tier2-filter";
import type { TriageEvent, TriageEventListResult } from "./types";

/**
 * Per-dimension fetch cap (#453 acceptance). A single dimension fetch
 * walks at most {@link TIER2_PER_DIMENSION_CAP} events; the cap
 * implies up to 50 round-trips at {@link REVIEW_MAX_PAGE_SIZE}.
 */
export const TIER2_PER_DIMENSION_CAP = 5_000;

export interface Tier2FetchInput {
  periodStartIso: string;
  periodEndIso: string;
  dimension: Tier2Dimension;
  valueKey: string;
  /**
   * When true, paginate only a single first page so the caller can
   * peek `totalCount` (and the first-page event count) before
   * committing to a full walk. The hook uses this to decide whether
   * the pre-fetch confirmation modal applies.
   */
  firstPageOnly?: boolean;
  /**
   * Resume pagination from this cursor instead of starting fresh.
   * The hook passes the peek's `endCursor` here so the full walk
   * does not redo the first page already returned by the peek.
   */
  afterCursor?: string | null;
}

export interface Tier2FetchResult {
  events: TriageEvent[];
  /** REview's `EventConnection.totalCount` from the first page (or null). */
  totalCount: string | null;
  /** True when the per-dimension cap was hit AND REview reports more pages. */
  truncated: boolean;
  /**
   * True when REview reports more pages remain after the last fetched
   * page. Distinguishes "peek returned everything" from "peek has more
   * to go" so the caller can skip a redundant follow-up fetch in the
   * former case.
   */
  hasMore: boolean;
  /**
   * Cursor pointing past the last fetched page; `null` when no more
   * pages remain. Used to resume after a peek without redoing the
   * first page.
   */
  endCursor: string | null;
}

interface Tier2EventListVariables extends Record<string, unknown> {
  filter: EventListFilterInput;
  first: number;
  after: string | null;
}

export async function fetchTier2DimensionWithSession(
  session: AuthSession,
  input: Tier2FetchInput,
  signal?: AbortSignal,
): Promise<Tier2FetchResult> {
  const ctx = await buildDispatchContext(session);
  const jwtCustomerIds = jwtCustomerIdsForTriage(ctx);

  const filter = buildTier2Filter({
    periodStartIso: input.periodStartIso,
    periodEndIso: input.periodEndIso,
    dimension: input.dimension,
    valueKey: input.valueKey,
  });
  if (filter === null) {
    return {
      events: [],
      totalCount: null,
      truncated: false,
      hasMore: false,
      endCursor: null,
    };
  }
  return paginateTier2(filter, ctx.role, jwtCustomerIds, signal, {
    firstPageOnly: input.firstPageOnly === true,
    afterCursor: input.afterCursor ?? null,
  });
}

async function paginateTier2(
  filter: EventListFilterInput,
  role: string,
  jwtCustomerIds: number[] | undefined,
  signal: AbortSignal | undefined,
  opts: { firstPageOnly: boolean; afterCursor: string | null },
): Promise<Tier2FetchResult> {
  const events: TriageEvent[] = [];
  let cursor: string | null = opts.afterCursor;
  let totalCount: string | null = null;
  let truncated = false;
  let hasMore = false;
  let endCursor: string | null = null;
  // Bound the loop independently of `hasNextPage` so a misbehaving
  // backend cannot wedge the fetch in an infinite walk. Peek calls
  // cap at one page; full walks at the per-dimension cap (50 pages
  // plus one safety margin at 100/page).
  const maxPages = opts.firstPageOnly
    ? 1
    : Math.ceil(TIER2_PER_DIMENSION_CAP / REVIEW_MAX_PAGE_SIZE) + 1;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const remaining = TIER2_PER_DIMENSION_CAP - events.length;
    if (remaining <= 0) break;
    const first = Math.min(REVIEW_MAX_PAGE_SIZE, remaining);
    const data: TriageEventListResult = await withReviewErrorMapping(
      graphqlRequest<TriageEventListResult, Tier2EventListVariables>(
        TRIAGE_EVENT_LIST_QUERY,
        { filter, first, after: cursor },
        { role, customerIds: jwtCustomerIds },
        signal,
      ),
    );
    const page = data.eventList;
    if (totalCount === null) totalCount = page.totalCount ?? null;
    events.push(...page.nodes);
    if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) {
      hasMore = false;
      endCursor = null;
      break;
    }
    cursor = page.pageInfo.endCursor;
    endCursor = cursor;
    if (events.length >= TIER2_PER_DIMENSION_CAP) {
      truncated = true;
      hasMore = true;
      break;
    }
    if (opts.firstPageOnly) {
      hasMore = true;
      break;
    }
  }
  return { events, totalCount, truncated, hasMore, endCursor };
}
