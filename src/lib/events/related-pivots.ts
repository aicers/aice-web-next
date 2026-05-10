"use server";

import { getCurrentSession } from "@/lib/auth/session";
import { searchEvents } from "@/lib/detection";
import type { EventListFilterInput } from "@/lib/detection/types";

/**
 * Per-pivot snippet shown in the Related Events tab.
 *
 * `count` is REview's `totalCount` (a numeric string for very large
 * windows). `lastTime` is the most recent event time observed in a
 * bounded sample of the window — computed client-side as the max
 * `time` across the returned nodes, so correctness does not depend
 * on any ordering guarantee from REview's `eventList` (the schema
 * documents no ordering). It is honest best-effort: when the window
 * is large enough that the sample misses the actual latest event,
 * the snippet may trail the true max; it never reports a value that
 * is not an actual event in the window. `null` when the window is
 * empty.
 */
export interface RelatedPivotSummary {
  id: PivotId;
  count: string;
  lastTime: string | null;
}

export type PivotId =
  | "same-source"
  | "same-destination"
  | "same-kind"
  | "same-session";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

/**
 * Size of the sample used to compute the "last seen" timestamp.
 * REview does not promise a sort order on `eventList`, so we pick
 * the max `time` across a bounded sample rather than trusting a
 * single node's position. 25 is enough to recover the true max for
 * the windows users look at in practice (≤7 days) while keeping
 * per-pivot cost low.
 */
const LAST_SEEN_SAMPLE_SIZE = 25;

interface PivotSpec {
  id: PivotId;
  windowMs: number;
  filter: EventListFilterInput;
}

/**
 * Narrow projection of the resolved event used as the anchor for
 * the four Related pivot summaries.
 *
 * The Related tab passes only these fields across the server-action
 * boundary so that the larger `Event` payload (which for HTTP-class
 * subtypes carries `password`, `cookie`, `body`, and other sensitive
 * fields selected by `EVENT_BY_ID_QUERY`) never leaves the page.
 */
export interface RelatedPivotAnchor {
  time: string;
  kind: string;
  origAddr: string | null;
  respAddr: string | null;
}

function buildPivotSpecs(anchor: RelatedPivotAnchor): PivotSpec[] {
  const { origAddr, respAddr, kind } = anchor;
  const specs: PivotSpec[] = [];
  if (origAddr) {
    specs.push({
      id: "same-source",
      windowMs: ONE_DAY_MS,
      filter: { source: origAddr },
    });
  }
  if (respAddr) {
    specs.push({
      id: "same-destination",
      windowMs: ONE_DAY_MS,
      filter: { destination: respAddr },
    });
  }
  specs.push({
    id: "same-kind",
    windowMs: SEVEN_DAYS_MS,
    filter: { kinds: [kind] },
  });
  if (origAddr && respAddr) {
    specs.push({
      id: "same-session",
      windowMs: ONE_DAY_MS,
      filter: { source: origAddr, destination: respAddr },
    });
  }
  return specs;
}

function shiftIso(time: string, deltaMs: number): string {
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return time;
  return new Date(date.getTime() + deltaMs).toISOString();
}

/**
 * Fetch the four Related Events pivot summaries in parallel.
 *
 * Server action: invoked by the Related tab once it activates so
 * that REview is not contacted for users who never open the tab.
 * Authorization is enforced transitively via `searchEvents` →
 * `buildDispatchContext`.
 *
 * Each summary uses a tight, time-bounded `EventListFilterInput`
 * anchored on the resolved event's `time`. Errors are swallowed
 * per-pivot — a single failing snippet should not blank the whole
 * tab. The caller passes the narrow `RelatedPivotAnchor` shape
 * rather than the full resolved `Event`, so sensitive payload
 * fields like `password` / `cookie` / `body` never cross the
 * server-action boundary.
 */
export async function fetchRelatedPivotSummaries(
  anchor: RelatedPivotAnchor,
): Promise<RelatedPivotSummary[]> {
  const session = await getCurrentSession();
  if (!session) {
    return buildPivotSpecs(anchor).map((spec) => ({
      id: spec.id,
      count: "0",
      lastTime: null,
    }));
  }
  const specs = buildPivotSpecs(anchor);
  const end = anchor.time;
  return Promise.all(
    specs.map(async (spec): Promise<RelatedPivotSummary> => {
      const start = shiftIso(end, -spec.windowMs);
      try {
        const page = await searchEvents(
          session,
          {
            mode: "structured",
            input: { ...spec.filter, start, end },
          },
          { first: LAST_SEEN_SAMPLE_SIZE },
        );
        return {
          id: spec.id,
          count: page.totalCount,
          lastTime: maxTime(page.nodes),
        };
      } catch {
        return { id: spec.id, count: "0", lastTime: null };
      }
    }),
  );
}

/**
 * Pick the max `time` across a node sample. Returns `null` when the
 * sample is empty so the caller renders "No matches in window".
 */
function maxTime(nodes: readonly { time: string }[]): string | null {
  let best: string | null = null;
  for (const node of nodes) {
    if (best === null || node.time > best) best = node.time;
  }
  return best;
}
