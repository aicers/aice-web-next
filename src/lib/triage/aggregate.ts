/**
 * Pure aggregation of Triage events into the funnel + asset list +
 * scored corpus.
 *
 * Kept separate from the server-action layer so the scoring +
 * grouping logic is unit-testable without mocking the GraphQL
 * round-trip.
 */

import { baselineScore } from "./scoring";
import { DEFAULT_STRICTNESS_STOP_ID } from "./strictness/stops";
import type {
  ScoredTriageEvent,
  TriageAsset,
  TriageEvent,
  TriageFreshness,
  TriageFunnel,
  TriageLoadResult,
} from "./types";

/** How many events the asset detail panel keeps per asset. */
const ASSET_DETAIL_EVENT_LIMIT = 50;

interface AssetAccumulator {
  customerId: number;
  customerName: string;
  address: string;
  detectedCount: number;
  triagedCount: number;
  score: number;
  /** Newest baseline-passing event time seen so far; `null` until set. */
  lastEventTimeIso: string | null;
  events: ScoredTriageEvent[];
}

function emptyAccumulator(
  customerId: number,
  customerName: string,
  address: string,
): AssetAccumulator {
  return {
    customerId,
    customerName,
    address,
    detectedCount: 0,
    triagedCount: 0,
    score: 0,
    lastEventTimeIso: null,
    events: [],
  };
}

const EMPTY_FRESHNESS: TriageFreshness = { worst: null, customers: [] };

/** Build the composite asset-list React key. */
function assetEventRowKey(
  customerId: number,
  address: string,
  index: number,
): string {
  return `${customerId}/${address}#${index}`;
}

function compareEventsNewestFirst(
  a: ScoredTriageEvent,
  b: ScoredTriageEvent,
): number {
  // ISO-8601 strings sort lexicographically in calendar order.
  if (a.time < b.time) return 1;
  if (a.time > b.time) return -1;
  return 0;
}

/**
 * Asset list ordering. Primary keys are the issue's contract —
 * `score DESC, last_event_time DESC` — so cross-customer merges
 * preserve the same ordering the per-tenant SQL `ORDER BY` produced.
 * `lastEventTimeIso` is compared lexicographically (ISO-8601 strings
 * sort in calendar order). The remaining keys
 * (`triagedCount`, `detectedCount`, `address`, `customerId`) keep
 * the page deterministic when `score` AND `last_event_time` are
 * both tied — they're not part of the issue contract but provide a
 * stable order across reloads.
 */
export function compareAssets(a: TriageAsset, b: TriageAsset): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.lastEventTimeIso !== b.lastEventTimeIso) {
    // Newer first; `null` (no events in window) sorts last.
    if (a.lastEventTimeIso === null) return 1;
    if (b.lastEventTimeIso === null) return -1;
    if (a.lastEventTimeIso < b.lastEventTimeIso) return 1;
    if (a.lastEventTimeIso > b.lastEventTimeIso) return -1;
  }
  if (a.triagedCount !== b.triagedCount) {
    return b.triagedCount - a.triagedCount;
  }
  if (a.detectedCount !== b.detectedCount) {
    return b.detectedCount - a.detectedCount;
  }
  if (a.address !== b.address) return a.address.localeCompare(b.address);
  return a.customerId - b.customerId;
}

/**
 * Reduce a flat list of events into the Triage page payload.
 *
 * Events without a usable originator IP (e.g., aggregate threat
 * subtypes that emit `origAddrs` plural) are still counted in the
 * funnel denominator and surface in the top-level scored `events`
 * list, but do not contribute to any asset row — Phase 1.A's asset
 * key is a single originator address and the issue is explicit that
 * the asset list is sorted by score.
 *
 * `customerId` defaults to `0` as a convenience for unit tests that
 * do not thread the value through. Production callers pass the
 * resolved tenant id so the composite asset key (`customerId, address`)
 * stays distinct end-to-end across multi-tenant scopes.
 */
export function aggregateTriageEvents(
  events: TriageEvent[],
  truncated: boolean,
  customerId = 0,
  customerName: string = String(customerId),
): TriageLoadResult {
  const funnel: TriageFunnel = {
    detected: events.length,
    triaged: 0,
    shown: 0,
    passThroughRate: 0,
  };
  const byAddress = new Map<string, AssetAccumulator>();
  const scoredEvents: ScoredTriageEvent[] = [];

  for (const event of events) {
    const score = baselineScore(event);
    const triaged = score > 0;
    if (triaged) funnel.triaged += 1;
    const scored: ScoredTriageEvent = { ...event, score, customerId };
    scoredEvents.push(scored);

    const address = typeof event.origAddr === "string" ? event.origAddr : null;
    if (!address) continue;

    const acc =
      byAddress.get(address) ??
      emptyAccumulator(customerId, customerName, address);
    acc.detectedCount += 1;
    if (triaged) {
      acc.triagedCount += 1;
      acc.score += score;
      // Track the newest baseline-passing event time for this asset.
      // ISO-8601 string compare matches calendar order, which is what
      // `compareAssets` needs for the `score DESC, last_event_time
      // DESC` tiebreaker contract.
      if (acc.lastEventTimeIso === null || event.time > acc.lastEventTimeIso) {
        acc.lastEventTimeIso = event.time;
      }
      // Only baseline-passing events feed the asset detail panel so
      // the row's score is always explainable: a mixed asset that has
      // both whitelisted and non-whitelisted events must not surface
      // score-0 noise that could push the actual scored events out of
      // the 50-event detail window.
      acc.events.push(scored);
    }
    byAddress.set(address, acc);
  }

  // Legacy in-memory aggregator has no slider / branch B / quota, so
  // `shown` collapses to `triaged` here (every triaged event reaches
  // the screen). Production reaches the funnel via `loadTriagePeriod`,
  // which computes `shown` from the dual-cap merge instead.
  funnel.shown = funnel.triaged;
  if (funnel.detected > 0) {
    funnel.passThroughRate = Math.min(
      1,
      Math.max(0, funnel.shown / funnel.detected),
    );
  }

  const assets: TriageAsset[] = Array.from(byAddress.values())
    // Per Phase 1.A: the asset list ranks assets that passed the
    // baseline rule. Addresses whose events are all non-triaged
    // (score 0) drop out so the empty state can read "No assets
    // matched the baseline rule in this period."
    .filter((acc) => acc.triagedCount > 0)
    .map(
      (acc): TriageAsset => ({
        customerId: acc.customerId,
        customerName: acc.customerName,
        address: acc.address,
        detectedCount: acc.detectedCount,
        detectedCountUnavailable: false,
        triagedCount: acc.triagedCount,
        score: acc.score,
        lastEventTimeIso: acc.lastEventTimeIso,
        events: acc.events
          .slice()
          .sort(compareEventsNewestFirst)
          .slice(0, ASSET_DETAIL_EVENT_LIMIT)
          .map((event, index) => ({
            ...event,
            rowKey: assetEventRowKey(acc.customerId, acc.address, index),
          })),
      }),
    )
    .sort(compareAssets);

  return {
    funnel,
    assets,
    truncated,
    storyProtectedTruncated: false,
    storyProtectedDroppedCount: 0,
    eligibleByStop: {},
    loadedEventCount: events.length,
    events: scoredEvents,
    observedDenominatorTruncated: false,
    freshness: EMPTY_FRESHNESS,
    strictness: DEFAULT_STRICTNESS_STOP_ID,
  };
}
