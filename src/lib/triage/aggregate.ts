/**
 * Pure aggregation of Triage events into the funnel + asset list.
 *
 * Kept separate from the server-action layer so the scoring +
 * grouping logic is unit-testable without mocking the GraphQL
 * round-trip.
 */

import { baselineScore } from "./scoring";
import type {
  TriageAsset,
  TriageEvent,
  TriageFunnel,
  TriageLoadResult,
} from "./types";

/** How many events the asset detail panel keeps per asset. */
const ASSET_DETAIL_EVENT_LIMIT = 50;

interface AssetAccumulator {
  address: string;
  detectedCount: number;
  triagedCount: number;
  score: number;
  events: TriageEvent[];
}

function emptyAccumulator(address: string): AssetAccumulator {
  return {
    address,
    detectedCount: 0,
    triagedCount: 0,
    score: 0,
    events: [],
  };
}

function compareEventsNewestFirst(a: TriageEvent, b: TriageEvent): number {
  // ISO-8601 strings sort lexicographically in calendar order.
  if (a.time < b.time) return 1;
  if (a.time > b.time) return -1;
  return 0;
}

function compareAssets(a: TriageAsset, b: TriageAsset): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.triagedCount !== b.triagedCount) {
    return b.triagedCount - a.triagedCount;
  }
  if (a.detectedCount !== b.detectedCount) {
    return b.detectedCount - a.detectedCount;
  }
  return a.address.localeCompare(b.address);
}

/**
 * Reduce a flat list of events into the Triage page payload.
 *
 * Events without a usable originator IP (e.g., aggregate threat
 * subtypes that emit `origAddrs` plural) are still counted in the
 * funnel denominator but do not contribute to any asset row — Phase
 * 1.A's asset key is a single originator address and the issue is
 * explicit that the asset list is sorted by score.
 */
export function aggregateTriageEvents(
  events: TriageEvent[],
  truncated: boolean,
): TriageLoadResult {
  const funnel: TriageFunnel = {
    detected: events.length,
    triaged: 0,
    passThroughRate: 0,
  };
  const byAddress = new Map<string, AssetAccumulator>();

  for (const event of events) {
    const score = baselineScore(event);
    const triaged = score > 0;
    if (triaged) funnel.triaged += 1;

    const address = typeof event.origAddr === "string" ? event.origAddr : null;
    if (!address) continue;

    const acc = byAddress.get(address) ?? emptyAccumulator(address);
    acc.detectedCount += 1;
    if (triaged) {
      acc.triagedCount += 1;
      acc.score += score;
    }
    acc.events.push(event);
    byAddress.set(address, acc);
  }

  if (funnel.detected > 0) {
    funnel.passThroughRate = Math.min(
      1,
      Math.max(0, funnel.triaged / funnel.detected),
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
        address: acc.address,
        detectedCount: acc.detectedCount,
        triagedCount: acc.triagedCount,
        score: acc.score,
        events: acc.events
          .slice()
          .sort(compareEventsNewestFirst)
          .slice(0, ASSET_DETAIL_EVENT_LIMIT)
          .map((event, index) => ({
            ...event,
            rowKey: `${acc.address}#${index}`,
          })),
      }),
    )
    .sort(compareAssets);

  return {
    funnel,
    assets,
    truncated,
    loadedEventCount: events.length,
  };
}
