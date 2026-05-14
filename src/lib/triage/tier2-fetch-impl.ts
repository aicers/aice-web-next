import "server-only";

import type { AuthSession } from "@/lib/auth/jwt";
import type { EventListFilterInput } from "@/lib/detection";
import { listSensors } from "@/lib/detection/sensors";
import { graphqlRequest } from "@/lib/graphql/client";
import { withReviewErrorMapping } from "@/lib/review/error-mapping";
import { classifyReviewSensorScopeError } from "@/lib/review/event-query-error";
import { REVIEW_MAX_PAGE_SIZE } from "@/lib/review/limits";

import {
  buildDispatchContext,
  jwtCustomerIdsForTriage,
} from "./dispatch-context";
import { TRIAGE_EVENT_LIST_QUERY } from "./queries";
import { TIER2_PER_DIMENSION_CAP } from "./tier2-cache";
import { buildTier2Filter, type Tier2Dimension } from "./tier2-filter";
import type { TriageEvent, TriageEventListResult } from "./types";

export { TIER2_PER_DIMENSION_CAP };

/**
 * Curated event cohort that bounds a Tier 2 fetch when present (#561).
 * Discriminator stays open so a future `{ kind: "savedSearch", ... }`
 * (or similar) can land without changing every dispatch site.
 */
export type Tier2CorpusSeed = Tier2StoryMembersSeed;

export interface Tier2StoryMembersSeed {
  kind: "storyMembers";
  /**
   * Stable composite identity of the source Story. Folded into the
   * Tier 2 cache key so a same-Story re-pivot reuses cached results
   * while two distinct Stories (or Story → Asset list) stay isolated.
   * The actual {@link eventKeys} list is intentionally NOT in the
   * cache key — Story membership is stable per session by the {@link
   * STORY_MEMBER_CAP} cohort, so `(customerId, storyId)` is enough
   * identity and the encoding stays bounded (#561).
   */
  customerId: number;
  storyId: string;
  /**
   * Member event-key set the resolver intersects against. Capped at
   * {@link STORY_MEMBER_CAP} = 50 by #489's correlator contract.
   */
  eventKeys: readonly string[];
}

export interface Tier2FetchInput {
  periodStartIso: string;
  periodEndIso: string;
  dimension: Tier2Dimension;
  valueKey: string;
  /**
   * Customer ID of the asset root the Tier 2 trail is anchored at.
   * Required so the `sameSensor` pivot can disambiguate a sensor
   * `name` (which is not unique across customers) to a unique
   * `(name, customerId)` tuple before resolving it to REview's
   * opaque `nodeId`. For other dimensions the value is unused but
   * required so the call sites cannot forget to thread the asset
   * context.
   */
  customerId: number;
  /**
   * Per-#561, optionally lifts the Tier 2 fetch onto a curated event
   * cohort instead of the period-wide asset corpus. When present,
   * dispatch routes through the member-keyed resolver
   * ({@link paginateTier2OverMemberCorpus}) so pagination and the
   * returned `totalCount` are computed against the cohort, not the
   * universe.
   *
   * Wire-shape choice (#561 design decision (a) — inline event-key
   * list): the member set caps at {@link STORY_MEMBER_CAP} = 50 per
   * #489, which keeps the payload small enough to inline without
   * adding an `event_group_member` join on the hot Tier 2 path. The
   * alternative `(customerId, storyId)` reference shape would buy
   * nothing at this cap and only matters if the cap is raised.
   */
  corpusSeed?: Tier2CorpusSeed;
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
  /**
   * Number of events the caller has already accumulated for this
   * dimension (e.g., from a prior peek). Subtracted from
   * {@link TIER2_PER_DIMENSION_CAP} so the merged total never exceeds
   * the per-dimension cap. Defaults to 0 — full walks start fresh.
   */
  alreadyFetched?: number;
  /**
   * Resolved REview `nodeId` from a prior peek's `(name, customerId)`
   * → `nodeId` lookup. Only meaningful for the `sameSensor` dimension.
   * When set, the dispatch reuses this id verbatim instead of running
   * `listSensors()` again — without this bypass, a modal-gated walk
   * would re-resolve the sensor name on Confirm, and if the lookup
   * result changed between peek and confirm the continuation would
   * paginate a different sensor against a stale `afterCursor` and
   * merge unrelated rows into the first page (#502).
   */
  resolvedSensorId?: string;
}

/**
 * Discriminator returned in {@link Tier2FetchResult.sensorFallback}
 * when the Tier 2 `sameSensor` pivot cannot complete against the
 * caller's scope. Both kinds surface a non-blocking toast and revert
 * the trail to the asset root, mirroring the stale-hash UX so the
 * operator never sees a generic error banner for a name that simply
 * no longer maps to an accessible sensor.
 *
 *   - `name-unresolved` — the clicked sensor name (or restored hash
 *     value) does not match a unique sensor under the asset's
 *     customer scope. Zero matches or — defensively — multiple
 *     matches after the customer filter both surface here.
 *   - `scope-forbidden` — review-web 0.33.0 tightened
 *     `eventList(filter: { sensors: [...] })` to return `Forbidden`
 *     when any supplied `nodeId` lies outside the caller's customer
 *     scope. Reaches this branch when a stale or rotated scope drops
 *     a previously-visible sensor mid-session.
 */
export type Tier2SensorFallbackKind = "name-unresolved" | "scope-forbidden";

export interface Tier2SensorFallback {
  kind: Tier2SensorFallbackKind;
  /** The clicked / restored sensor name (not the resolved nodeId). */
  sensorName: string;
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
  /**
   * Set when the `sameSensor` pivot resolved to a non-actionable
   * state (name unresolved within the asset's customer scope, or a
   * forbidden-sensor-scope rejection on the dispatch). The caller
   * surfaces a non-blocking toast and falls back to the asset root
   * rather than rendering the generic error banner — see
   * {@link Tier2SensorFallback}. Absent on every non-sensor pivot.
   */
  sensorFallback?: Tier2SensorFallback;
  /**
   * REview `nodeId` resolved from the `sameSensor` pivot's `(name,
   * customerId)` lookup, surfaced to the hook so a modal-gated
   * continuation can replay the *same* id against the peek's
   * `endCursor` instead of re-running `listSensors()` on Confirm —
   * without this, a lookup result that changed between peek and
   * confirm would let the resumed page paginate a different sensor
   * with a stale cursor (#502). Absent on every non-sensor pivot and
   * on `sameSensor` calls that landed in a `sensorFallback` (no id
   * was resolved).
   */
  resolvedSensorId?: string;
}

interface Tier2EventListVariables extends Record<string, unknown> {
  filter: EventListFilterInput;
  first: number;
  after: string | null;
}

const EMPTY_SENSOR_RESULT: Pick<
  Tier2FetchResult,
  "events" | "totalCount" | "truncated" | "hasMore" | "endCursor"
> = {
  events: [],
  totalCount: null,
  truncated: false,
  hasMore: false,
  endCursor: null,
};

export async function fetchTier2DimensionWithSession(
  session: AuthSession,
  input: Tier2FetchInput,
  signal?: AbortSignal,
): Promise<Tier2FetchResult> {
  const ctx = await buildDispatchContext(session);
  const jwtCustomerIds = jwtCustomerIdsForTriage(ctx);

  // `sameSensor` carries a sensor *name*, but
  // `EventListFilterInput.sensors` is `[ID!]`. Resolve to REview's
  // opaque `nodeId` against the shared lookup (now relaxed to a
  // `detection:read | triage:read` union — #502) and key the match
  // on `(name, customerId)` so a sensor named `edge-01` under one
  // tenant cannot select the same-named sensor under another. A
  // lookup transport error propagates as an ordinary fetch failure;
  // a name that does not resolve within the asset's customer scope
  // surfaces a non-blocking sensorFallback that the hook layer maps
  // to the asset-root toast.
  let resolvedValueKey = input.valueKey;
  let resolvedSensorId: string | undefined;
  if (input.dimension === "sameSensor") {
    if (input.resolvedSensorId !== undefined) {
      // Continuation path: reuse the peek's resolved id so the
      // `afterCursor` replay stays bound to the exact `nodeId` the
      // peek's first page was paginated against. If we re-ran
      // `listSensors()` here and the lookup result changed between
      // peek and confirm (sensor renamed / new tenant entry added /
      // race on the lookup endpoint), the continuation would
      // paginate a different sensor with a stale cursor and the
      // merged result would mix unrelated rows into the first page
      // (#502).
      resolvedValueKey = input.resolvedSensorId;
      resolvedSensorId = input.resolvedSensorId;
    } else {
      const lookup = await listSensors(session);
      if (!lookup.endpointAvailable) {
        // Defensive: the endpoint guard would have to regress for this
        // branch to trip. Treat as name-unresolved so the operator sees
        // the same "name no longer maps" affordance rather than a
        // crash.
        return {
          ...EMPTY_SENSOR_RESULT,
          sensorFallback: {
            kind: "name-unresolved",
            sensorName: input.valueKey,
          },
        };
      }
      const matches = lookup.sensors.filter(
        (s) => s.name === input.valueKey && s.customerId === input.customerId,
      );
      if (matches.length !== 1) {
        // Zero matches → genuine stale-name. Multiple matches after the
        // customer filter is defensively impossible (the lookup
        // contract is unique-by-(name, customerId)), but a regression
        // in REview shouldn't crash the menu — fall through to the
        // same fallback so the operator at least sees the trail revert.
        if (matches.length > 1) {
          console.warn(
            `Tier 2 sensor pivot: ${matches.length} sensors share name ` +
              `"${input.valueKey}" under customerId=${input.customerId}; ` +
              `expected a unique match. Falling back to the asset root.`,
          );
        }
        return {
          ...EMPTY_SENSOR_RESULT,
          sensorFallback: {
            kind: "name-unresolved",
            sensorName: input.valueKey,
          },
        };
      }
      resolvedValueKey = matches[0].id;
      resolvedSensorId = matches[0].id;
    }
  }

  const filter = buildTier2Filter({
    periodStartIso: input.periodStartIso,
    periodEndIso: input.periodEndIso,
    dimension: input.dimension,
    valueKey: resolvedValueKey,
  });
  if (filter === null) {
    return { ...EMPTY_SENSOR_RESULT };
  }
  try {
    // Story-member cohort branch (#561). The cohort is event-key-keyed
    // from the start: pagination walks REview's `eventList` with the
    // dimension filter and intersects each page with the member set,
    // so the returned `totalCount` is the count of matched member
    // events (not REview's universe count) and a member that sits on
    // a later page is not silently dropped by the per-dimension cap.
    // `firstPageOnly` / `afterCursor` / `alreadyFetched` do not apply
    // here — the cohort is bounded at `STORY_MEMBER_CAP` = 50 by
    // construction (#489), so the result fits in a single fetch and
    // the modal-gated continuation path is not reachable.
    if (input.corpusSeed) {
      const result = await paginateTier2OverMemberCorpus(
        filter,
        ctx.role,
        jwtCustomerIds,
        input.corpusSeed,
        signal,
      );
      return resolvedSensorId !== undefined
        ? { ...result, resolvedSensorId }
        : result;
    }
    const result = await paginateTier2(
      filter,
      ctx.role,
      jwtCustomerIds,
      signal,
      {
        firstPageOnly: input.firstPageOnly === true,
        afterCursor: input.afterCursor ?? null,
        alreadyFetched: Math.max(0, input.alreadyFetched ?? 0),
      },
    );
    return resolvedSensorId !== undefined
      ? { ...result, resolvedSensorId }
      : result;
  } catch (err) {
    // Map review-web 0.33.0's forbidden-on-sensor-scope back into a
    // sensorFallback so the menu reverts to the asset root with a
    // toast rather than the generic error banner. The shared
    // classifier (`@/lib/review/event-query-error`) is the single
    // source of truth for this discriminator across Detection and
    // Triage.
    if (input.dimension === "sameSensor") {
      const classification = classifyReviewSensorScopeError(
        err,
        filter.sensors ?? [],
      );
      if (classification.code === "forbidden-sensor-scope") {
        return {
          ...EMPTY_SENSOR_RESULT,
          sensorFallback: {
            kind: "scope-forbidden",
            sensorName: input.valueKey,
          },
        };
      }
    }
    throw err;
  }
}

/**
 * Member-corpus walk ceiling (#561). Applied only to the Story-member
 * resolver path. The walk runs until either (a) every member event-key
 * has been observed on a page, (b) REview reports no further pages,
 * or (c) this many universe rows have been scanned. The ceiling is
 * intentionally generous (a 10x multiplier on the per-dimension cap)
 * because the cohort is small (≤ {@link STORY_MEMBER_CAP} = 50) and
 * the walk has to reach far enough into REview's universe to surface
 * the rare member that sits on a later page.
 */
const TIER2_STORY_CORPUS_WALK_CAP = TIER2_PER_DIMENSION_CAP * 10;

/**
 * Member-keyed Tier 2 resolver (#561). This is the "separate event-
 * key-keyed resolver/query" the issue asks for — it is NOT a wrapper
 * around `eventList`'s pagination contract: pagination and
 * `totalCount` are computed against the member cohort, so the result
 * shape is the cohort's universe, not REview's. The implementation
 * happens to use REview's `eventList(filter)` to source candidate
 * rows because `event_key IN (…)` is not yet a supported filter on
 * `EventListFilterInput` (a future review-side schema change would
 * let this path swap the universe walk for an additive filter; see
 * the issue's "Out of scope" — the consolidation is filed as a
 * separate concern).
 *
 * Walk semantics:
 *   - Iterate REview's `eventList(filter)` page by page; each page is
 *     intersected against the member event-key set.
 *   - Stop when every member is accounted for, when REview reports no
 *     further pages, or when {@link TIER2_STORY_CORPUS_WALK_CAP}
 *     universe rows have been scanned.
 *   - `totalCount` = matched member count (cohort universe).
 *   - `truncated` = walk-cap hit AND not every member observed (the
 *     unobserved members may still satisfy the filter on later pages
 *     we could not reach).
 *   - `hasMore` / `endCursor` are reported as `false` / `null` — the
 *     cohort fits in a single result so the modal-gated continuation
 *     path (`firstPageOnly` / `afterCursor`) is not reachable here.
 */
async function paginateTier2OverMemberCorpus(
  filter: EventListFilterInput,
  role: string,
  jwtCustomerIds: number[] | undefined,
  corpusSeed: Tier2CorpusSeed,
  signal: AbortSignal | undefined,
): Promise<Tier2FetchResult> {
  const memberKeys = new Set<string>(corpusSeed.eventKeys);
  if (memberKeys.size === 0) {
    return {
      events: [],
      totalCount: "0",
      truncated: false,
      hasMore: false,
      endCursor: null,
    };
  }
  const matched = new Map<string, TriageEvent>();
  const observed = new Set<string>();
  let cursor: string | null = null;
  let scanned = 0;
  let truncated = false;
  // Bound the loop independently of `hasNextPage` so a misbehaving
  // backend cannot wedge the fetch in an infinite walk.
  const maxPages =
    Math.ceil(TIER2_STORY_CORPUS_WALK_CAP / REVIEW_MAX_PAGE_SIZE) + 1;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const data: TriageEventListResult = await withReviewErrorMapping(
      graphqlRequest<TriageEventListResult, Tier2EventListVariables>(
        TRIAGE_EVENT_LIST_QUERY,
        { filter, first: REVIEW_MAX_PAGE_SIZE, after: cursor },
        { role, customerIds: jwtCustomerIds },
        signal,
      ),
    );
    const page = data.eventList;
    for (const node of page.nodes) {
      if (memberKeys.has(node.id)) {
        observed.add(node.id);
        if (!matched.has(node.id)) matched.set(node.id, node);
      }
    }
    scanned += page.nodes.length;
    if (observed.size >= memberKeys.size) break;
    if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) break;
    if (scanned >= TIER2_STORY_CORPUS_WALK_CAP) {
      truncated = true;
      break;
    }
    cursor = page.pageInfo.endCursor;
  }
  const events = [...matched.values()];
  return {
    events,
    totalCount: String(events.length),
    truncated,
    hasMore: false,
    endCursor: null,
  };
}

async function paginateTier2(
  filter: EventListFilterInput,
  role: string,
  jwtCustomerIds: number[] | undefined,
  signal: AbortSignal | undefined,
  opts: {
    firstPageOnly: boolean;
    afterCursor: string | null;
    alreadyFetched: number;
  },
): Promise<Tier2FetchResult> {
  const events: TriageEvent[] = [];
  let cursor: string | null = opts.afterCursor;
  let totalCount: string | null = null;
  let truncated = false;
  let hasMore = false;
  let endCursor: string | null = null;
  // Per-dimension cap is shared between the peek and any continuation,
  // so the budget for this call is the cap minus what the caller has
  // already accumulated.
  const budget = Math.max(0, TIER2_PER_DIMENSION_CAP - opts.alreadyFetched);
  if (budget === 0) {
    return {
      events,
      totalCount: null,
      truncated: true,
      hasMore: true,
      endCursor: opts.afterCursor,
    };
  }
  // Bound the loop independently of `hasNextPage` so a misbehaving
  // backend cannot wedge the fetch in an infinite walk. Peek calls
  // cap at one page; full walks at the budget plus one safety margin
  // at 100/page.
  const maxPages = opts.firstPageOnly
    ? 1
    : Math.ceil(budget / REVIEW_MAX_PAGE_SIZE) + 1;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const remaining = budget - events.length;
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
    if (events.length >= budget) {
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
