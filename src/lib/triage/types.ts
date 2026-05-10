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
 * Membership shape of a customer-defined network. Mirrors REview's
 * `HostNetworkGroup` — exact hosts, CIDR networks, and inclusive IP
 * ranges. The triage classifier reads all three fields to decide
 * whether an address is inside the customer perimeter.
 */
export interface TriageHostNetworkGroup {
  hosts: string[];
  networks: string[];
  ranges: { start: string; end: string }[];
}

/**
 * Customer network attached to an event side. Only the
 * `networks` membership shape is selected by the triage query —
 * other `Network` fields (id, name, …) are not needed for
 * classification.
 */
export interface TriageNetwork {
  networks: TriageHostNetworkGroup;
}

/**
 * Slim event shape returned by the Triage `eventList` query.
 *
 * The selection set lives in {@link TRIAGE_EVENT_LIST_QUERY}; this
 * mirror only carries fields the page actually consumes (scoring,
 * asset extraction, asset-detail display, and the pivot dimensions
 * #452 / #453 will index over). Coverage is uneven across subtypes
 * (e.g. `RdpBruteForce` exposes no resp-side fields), so every
 * non-required field is optional and consumers must treat absent
 * fields as `null`.
 */
export interface TriageEvent {
  __typename: string;
  time: string;
  sensor: string;
  category: ThreatCategory | null;
  level: ThreatLevel;
  /** Originator IP — present on every curated subtype the page handles. */
  origAddr?: string | null;
  /** Responder IP — present on most but not all subtypes. */
  respAddr?: string | null;
  origPort?: number | null;
  respPort?: number | null;
  origCountry?: string | null;
  respCountry?: string | null;
  /** Customer-defined originator network membership. */
  origNetwork?: TriageNetwork | null;
  /** Customer-defined responder network membership. */
  respNetwork?: TriageNetwork | null;
  /** Cluster ID; only `HttpThreat` selects it in the query. */
  clusterId?: string | null;
  // HTTP-shaped subtypes only.
  host?: string | null;
  uri?: string | null;
  userAgent?: string | null;
  // DNS-shaped subtypes only.
  query?: string | null;
  answer?: string | null;
  // TLS-shaped subtypes only.
  ja3?: string | null;
  ja3S?: string | null;
  serverName?: string | null;
  serial?: string | null;
  subjectCommonName?: string | null;
  /**
   * Stable per-render React key for the asset detail panel. Populated
   * by {@link aggregateTriageEvents} so the list rows have a unique
   * identity even when several events share `time` + `__typename`.
   */
  rowKey?: string;
}

/**
 * Post-aggregation event shape with the locally-computed baseline
 * score attached. `score === 0` for events that do not pass the
 * baseline rule. Carries `score` separately from `TriageEvent` so
 * the GraphQL-mapping type stays free of computed fields.
 */
export interface ScoredTriageEvent extends TriageEvent {
  score: number;
}

/** Result of one `eventList` page in the triage query. */
export interface TriageEventListPage {
  pageInfo: {
    hasPreviousPage: boolean;
    hasNextPage: boolean;
    startCursor: string | null;
    endCursor: string | null;
  };
  /**
   * REview's `EventConnection.totalCount`, typed as `StringNumber!`.
   * Kept as a string and compared via {@link compareStringNumber}
   * (BigInt-safe) so a 2^53+ count never loses precision. Tier 2's
   * pre-fetch projection compares this to 20,000 before issuing the
   * dimension fetch.
   */
  totalCount: string;
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
  /**
   * Up to 50 baseline-passing events for the asset detail panel;
   * ordered newest first. Each event carries its per-event `score`
   * so the detail panel can render score per row.
   */
  events: ScoredTriageEvent[];
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
  /**
   * Every loaded event with its baseline score attached
   * (`score === 0` for non-baseline-passing rows). #452 builds its
   * pivot index over this full list — not over `assets[*].events`,
   * which is capped at 50 and filters out non-baseline events.
   */
  events: ScoredTriageEvent[];
}

export interface TriageError {
  kind: "forbidden" | "forbidden-scope" | "unknown";
  message?: string;
}
