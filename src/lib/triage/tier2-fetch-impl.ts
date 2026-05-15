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
import { TRIAGE_EVENT_BY_ID_QUERY, TRIAGE_EVENT_LIST_QUERY } from "./queries";
import { TIER2_PER_DIMENSION_CAP } from "./tier2-cache";
import {
  buildTier2Filter,
  type Tier2Dimension,
  tier2MatchesEvent,
} from "./tier2-filter";
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
   * ({@link fetchTier2OverMemberCorpus}) — each member is fetched by
   * id in parallel and the Tier 2 predicate is applied in-app — so
   * pagination and the returned `totalCount` are computed against the
   * cohort, not REview's universe.
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
  //
  // Story-corpus branch (#561) skips the resolution: the new
  // member-keyed resolver compares the clicked sensor name against
  // each fetched member event's `sensor` field directly (no
  // `eventList(filter: { sensors: [...] })` round-trip), so the
  // opaque `nodeId` is not needed and the lookup would just add an
  // unnecessary round-trip plus widen the failure surface for the
  // cohort path.
  let resolvedValueKey = input.valueKey;
  let resolvedSensorId: string | undefined;
  if (input.dimension === "sameSensor" && !input.corpusSeed) {
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
    // from the start: each member is fetched by id in parallel and the
    // Tier 2 predicate is evaluated in-app against the cohort, so the
    // returned `totalCount` is the count of matched member events
    // (cohort universe), pagination is bounded by the cohort by
    // construction, and a partial-match dimension click never falls
    // back to walking REview's universe-wide `eventList(filter)`
    // stream. `firstPageOnly` / `afterCursor` / `alreadyFetched` do
    // not apply — the cohort caps at `STORY_MEMBER_CAP` = 50 (#489)
    // and the result fits in a single fetch by construction. Note we
    // pass the original `input.valueKey` (not `resolvedValueKey`):
    // for `sameSensor` the cohort branch matches on the literal
    // sensor *name* carried in each member event's `sensor` field,
    // not on REview's opaque `nodeId`.
    if (input.corpusSeed) {
      return await fetchTier2OverMemberCorpus(
        input.dimension,
        input.valueKey,
        ctx.role,
        jwtCustomerIds,
        input.corpusSeed,
        signal,
      );
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
 * Member-keyed Tier 2 resolver (#561). The "separate event-key-keyed
 * resolver/query" the issue asks for — keyed on the cohort from the
 * start, NOT a wrapper around `eventList`'s pagination contract.
 *
 * Strategy:
 *   - Fetch each member event by id in parallel via `event(id:)`. The
 *     cohort caps at {@link STORY_MEMBER_CAP} = 50 (#489), so the
 *     fan-out is bounded.
 *   - Apply the Tier 2 predicate ({@link tier2MatchesEvent}) in-app
 *     against each fetched member. The predicate mirrors REview's
 *     server-side `EventListFilterInput` semantics for every Tier 2
 *     dimension this issue lifts onto the cohort.
 *   - Drop members that resolve to `null` (out of caller scope, sensor
 *     scope rotated, or deleted between Story member-list capture and
 *     the Tier 2 click). The cohort still reports the matched count
 *     correctly — a missing member just is not in the universe.
 *
 * Why per-id rather than walking `eventList(filter)`: the previous
 * implementation walked REview's universe-wide stream and stopped only
 * when every member key appeared in the filtered output, which (a) is
 * unreachable for high-cardinality / partially-matching pivots —
 * `externalIp=1.2.3.4` typically only matches a few members, so the
 * walk runs to the universe page tail or the defensive walk-cap;
 * (b) silently dropped matching members that sat past the walk-cap;
 * (c) flagged `truncated=true` even when every matching member had
 * already been collected, just because some non-matching members
 * never appeared. Per-id fetch + local predicate sidesteps every one
 * of those failure modes — pagination is the cohort by construction.
 *
 * The cross-repo alternative — an additive `event_key IN (…)` filter
 * on review's `EventListFilterInput` — stays out of scope per the
 * issue. A future consolidation issue may swap this resolver for that
 * path if the upstream filter lands.
 */
async function fetchTier2OverMemberCorpus(
  dimension: Tier2Dimension,
  valueKey: string,
  role: string,
  jwtCustomerIds: number[] | undefined,
  corpusSeed: Tier2CorpusSeed,
  signal: AbortSignal | undefined,
): Promise<Tier2FetchResult> {
  const memberKeys = corpusSeed.eventKeys;
  if (memberKeys.length === 0) {
    return {
      events: [],
      totalCount: "0",
      truncated: false,
      hasMore: false,
      endCursor: null,
    };
  }
  const fetched = await Promise.all(
    memberKeys.map((id) =>
      withReviewErrorMapping(
        graphqlRequest<Tier2EventByIdResult, Tier2EventByIdVariables>(
          TRIAGE_EVENT_BY_ID_QUERY,
          { id },
          { role, customerIds: jwtCustomerIds },
          signal,
        ),
      ).then((data) => data.event),
    ),
  );
  const matched: TriageEvent[] = [];
  const seen = new Set<string>();
  for (const event of fetched) {
    if (event === null || event === undefined) continue;
    if (seen.has(event.id)) continue;
    if (!tier2MatchesEvent(event, dimension, valueKey)) continue;
    seen.add(event.id);
    matched.push(event);
  }
  return {
    events: matched,
    totalCount: String(matched.length),
    truncated: false,
    hasMore: false,
    endCursor: null,
  };
}

interface Tier2EventByIdResult {
  event: TriageEvent | null;
}

interface Tier2EventByIdVariables extends Record<string, unknown> {
  id: string;
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
