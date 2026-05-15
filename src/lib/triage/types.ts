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
  /**
   * Stable opaque per-event id from REview's `Event` interface
   * (review-web 0.32.0+ / review 0.49.0+). `ID!` end-to-end — treated
   * as `string` per the codebase's `IDScalar` convention. Sole input
   * to {@link tier2DedupeKey} so Tier 2 dedupe collapses repeats by
   * identity rather than by a fragile composite of network fields.
   */
  id: string;
  time: string;
  sensor: string;
  category: ThreatCategory | null;
  /**
   * Threat level. `null` in Baseline mode (1B-3 / #458): the column is
   * not present on `baseline_triaged_event`, so corpus-sourced rows
   * arrive without a level. Policy mode keeps full `eventList` payload
   * coverage and surfaces a real `ThreatLevel`. Consumers must treat
   * `null` as "level not available" — Baseline mode hides the
   * level-based UI affordances rather than guessing a value.
   */
  level: ThreatLevel | null;
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
   * `LearningMethod` enum value (`SUPERVISED` / `UNSUPERVISED`) when
   * the subtype carries it. Used by the Tier 2 `learningMethods`
   * predicate that the Story-member resolver evaluates in-app — see
   * `tier2MatchesEvent` and {@link TRIAGE_EVENT_BY_ID_QUERY}. Subtypes
   * without this field (e.g. portscan / brute-force without learning
   * provenance) leave it `null` / `undefined`.
   */
  learningMethod?: string | null;
  // SSH (BlocklistSsh only). Per-protocol identifier pivots (#503).
  /** SSH client version string (e.g. `SSH-2.0-OpenSSH_8.4`). */
  sshClient?: string | null;
  /** SSH server version string. */
  sshServer?: string | null;
  /** HASSH client fingerprint (SSH analogue of JA3). */
  sshHassh?: string | null;
  /** HASSH server fingerprint (SSH analogue of JA3S). */
  sshHasshServer?: string | null;
  // SMB (BlocklistSmb only). Per-protocol identifier pivots (#503).
  smbPath?: string | null;
  smbService?: string | null;
  smbFileName?: string | null;
  /**
   * FTP commands (BlocklistFtp, FtpPlainText). The schema exposes this
   * as `[FtpCommand!]!` — an object list — so the selection picks the
   * pivot-meaningful nested `command` scalar. The extractor walks the
   * array and emits one pivot value per element (`RETR`, `STOR`, etc.).
   * `FtpBruteForce` does not carry this field.
   */
  ftpCommands?: { command: string }[] | null;
  // LDAP (BlocklistLdap, LdapPlainText). `LdapBruteForce` does not
  // carry these fields.
  ldapOpcode?: string[] | null;
  ldapObject?: string[] | null;
  ldapArgument?: string[] | null;
  // MQTT (BlocklistMqtt). Topic subscription list — the SDL exposes
  // no scalar `topic` field, so the dimension is named after the SDL.
  mqttSubscribe?: string[] | null;
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
 *
 * `customerId` is the tenant attribution for the event. Required for
 * multi-customer scopes so two customers hosting the same RFC1918
 * address keep their event sets distinct in the pivot index and in
 * `resolveStepFocusEvents` — filtering on `origAddr` alone would
 * collapse them. Defaults to `0` when callers do not yet thread the
 * value through (legacy in-memory aggregation paths).
 */
export interface ScoredTriageEvent extends TriageEvent {
  score: number;
  customerId: number;
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
 * Aggregate stats for one asset within the loaded period. Score /
 * triagedCount come from the baseline rule.
 *
 * The asset key is the composite `(customerId, address)` — two
 * customers can legitimately host the same private RFC1918 address on
 * different perimeters and the menu must keep them distinct end-to-
 * end. Single-customer scope is the common case and renders
 * identically to the pre-multi-customer model with a constant
 * `customerId`.
 */
export interface TriageAsset {
  /**
   * Customer the asset belongs to. Part of the composite asset key.
   * The asset list, URL hash focus, React keys, and pivot Tier 2
   * fetch keys all key off `(customerId, address)`.
   */
  customerId: number;
  /**
   * Display name of the customer (`customers.name`). Surfaced in the
   * asset detail header so two tenants hosting the same RFC1918
   * address remain understandable after selection. Falls back to the
   * stringified `customerId` when the central DB has no matching row
   * (a tenant DB present in the customer pool but not registered in
   * `customers`).
   */
  customerName: string;
  /** Originator IP address. The other half of the composite asset key. */
  address: string;
  /**
   * Total events observed for this asset's window contribution from
   * `observed_event_meta`. Stays `number` (no `null` widening) so the
   * existing sort / label / formatting code keeps working. The
   * "denominator unavailable" signal lives on
   * {@link detectedCountUnavailable} instead.
   */
  detectedCount: number;
  /**
   * `true` when the observed denominator for this asset's window
   * contribution is retention-truncated — i.e. the window starts
   * before `now() − observed_event_meta_retention` AND the in-
   * retention slice produces no observed rows for this address. Drives
   * the per-row "Detected over last 30d" label. Defaults to `false`.
   */
  detectedCountUnavailable: boolean;
  /** Events that pass the baseline rule. */
  triagedCount: number;
  /** Sum of per-event baseline scores. Sort key for the asset list. */
  score: number;
  /**
   * ISO timestamp of the most recent baseline-passing event for this
   * asset within the period. Carried through from
   * `MAX(b.event_time)` in the per-tenant aggregate SELECT so the
   * cross-customer merge can preserve the issue's
   * `score DESC, last_event_time DESC` ordering — without it, equal-
   * score rows from different tenants reorder on tiebreakers that
   * are not part of the issue contract. `null` only when the asset
   * has no events in the loaded window (degenerate path from the
   * in-memory `aggregateTriageEvents` test fixtures).
   */
  lastEventTimeIso: string | null;
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
  /**
   * `true` whenever the selected window starts before
   * `now() − observed_event_meta_retention` (i.e. the window's
   * earliest moment is older than 30 days ago). Drives the funnel's
   * "Detected over last 30d" affordance. Independent of per-row
   * availability — a 45-day-old window with plenty of observed rows
   * in its in-retention slice still sets this flag.
   */
  observedDenominatorTruncated: boolean;
  /**
   * Per-customer cadence freshness summary, keyed for the freshness
   * header. Aggregated across the caller's customer scope so the
   * header can render the worst-state badge plus a tooltip listing
   * affected customer ids.
   */
  freshness: TriageFreshness;
}

/**
 * One customer's freshness reading, as derived from
 * `baseline_corpus_state` in that customer's tenant DB. The header's
 * UI states are computed from `(status, lastIngestedAtIso, present)`.
 */
export interface TriageCustomerFreshness {
  customerId: number;
  /** `null` when the corpus-state row has not been written yet. */
  status: "ok" | "running" | "failed" | null;
  /** ISO timestamp; `null` when the first cadence has not committed. */
  lastIngestedAtIso: string | null;
  /** `true` when no row exists in `baseline_corpus_state`. */
  rowAbsent: boolean;
  /** Operator-facing error message, present only when `status === 'failed'`. */
  lastError: string | null;
}

/**
 * Result-level freshness summary. The header derives its rendering
 * from `worst` (the picked customer's state, surfaced in the badge)
 * plus the full `customers[]` list (used for the "across K customers"
 * tooltip and the affected-customer ids when one tenant is failed
 * while others are ok).
 */
export interface TriageFreshness {
  /**
   * Picked customer's freshness — the worst state across the scope so
   * the operator never sees a green header masking a tenant failure.
   * `null` only when the caller's customer scope is empty.
   */
  worst: TriageCustomerFreshness | null;
  /** Per-customer breakdown for the multi-customer tooltip. */
  customers: TriageCustomerFreshness[];
}

export interface TriageError {
  kind: "forbidden" | "forbidden-scope" | "unknown";
  message?: string;
}
