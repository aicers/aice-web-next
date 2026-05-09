import type { ThreatCategory, ThreatLevel } from "@/lib/detection";

/**
 * Hard cap on the number of events the Triage page loads for one
 * period. The page surfaces a "Partial: showing N of period
 * (truncated at 5,000)" banner when the cap is hit (per #451
 * acceptance). Lives in this module — separate from
 * `server-actions.ts` — so client components can read the constant
 * without dragging the server-only fetch path into the browser
 * bundle.
 */
export const TRIAGE_HARD_EVENT_CAP = 5_000;

/**
 * Slim event shape returned by the Triage `eventList` query.
 *
 * The selection set lives in {@link TRIAGE_EVENT_LIST_QUERY}; this
 * mirror only carries fields the page actually consumes (scoring,
 * asset extraction, asset-detail display).
 */
export interface TriageEvent {
  __typename: string;
  time: string;
  sensor: string;
  category: ThreatCategory | null;
  level: ThreatLevel;
  /** Originator IP — present on every curated subtype the page handles. */
  origAddr?: string | null;
  /** Cluster ID; only `HttpThreat` selects it in the query. */
  clusterId?: string | null;
  /**
   * Stable per-render React key for the asset detail panel. Populated
   * by {@link aggregateTriageEvents} so the list rows have a unique
   * identity even when several events share `time` + `__typename`.
   */
  rowKey?: string;
}

/** Result of one `eventList` page in the triage query. */
export interface TriageEventListPage {
  pageInfo: {
    hasPreviousPage: boolean;
    hasNextPage: boolean;
    startCursor: string | null;
    endCursor: string | null;
  };
  edges: { cursor: string }[];
  nodes: TriageEvent[];
}

export interface TriageEventListResult {
  eventList: TriageEventListPage;
}

/**
 * Aggregate stats for one asset (one originator IP) within the
 * loaded period. Score / triagedCount come from the baseline rule.
 */
export interface TriageAsset {
  /** Originator IP address; the asset key. */
  address: string;
  /** Total events observed for this asset within the period. */
  detectedCount: number;
  /** Events that pass the baseline rule. */
  triagedCount: number;
  /** Sum of per-event baseline scores. Sort key for the asset list. */
  score: number;
  /** Up to 50 events for the asset detail panel; ordered newest first. */
  events: TriageEvent[];
}

/** Funnel summary for the Triage page. */
export interface TriageFunnel {
  detected: number;
  triaged: number;
  /** `triaged / detected` clamped to `[0, 1]`. NaN-safe. */
  passThroughRate: number;
}

export interface TriageLoadResult {
  funnel: TriageFunnel;
  assets: TriageAsset[];
  /** True when the loaded slice hit the 5,000-event cap. */
  truncated: boolean;
  /** Number of events actually loaded (≤ {@link TRIAGE_HARD_EVENT_CAP}). */
  loadedEventCount: number;
}

export interface TriageError {
  kind: "forbidden" | "forbidden-scope" | "unknown";
  message?: string;
}
