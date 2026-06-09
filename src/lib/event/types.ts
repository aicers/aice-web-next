/**
 * Hand-written result and input types mirroring the Giganto 0.27.0 SDL
 * (`schemas/giganto.graphql`) for the Event-menu data layer.
 *
 * Kept hand-written (not codegen'd) to match the Node/Triage feature
 * libs: the selection sets are small and local. The 64-bit numeric
 * scalars Giganto serializes as strings — `StringNumberU64` (byte and
 * packet counts) and `StringNumberI64` (duration, in nanoseconds) — are
 * typed as `string` here and must never be cast to a JS number, or
 * precision is lost above 2^53.
 */

// ── Filter inputs (map to NetworkFilter) ───────────────────────────

/** `TimeRange` — start inclusive, end exclusive, both optional. */
export interface TimeRangeInput {
  start?: string | null;
  end?: string | null;
}

/** `IpRange` — start/end are IP **strings** (Giganto stores IPs as text). */
export interface IpRangeInput {
  start?: string | null;
  end?: string | null;
}

/** `PortRange` — start/end are port numbers. */
export interface PortRangeInput {
  start?: number | null;
  end?: number | null;
}

/**
 * `NetworkFilter` input. `sensor` is a single `String!` (not a list),
 * so the Event menu ships a single-sensor selector — multi-sensor
 * fan-out is deferred.
 */
export interface NetworkFilterInput extends Record<string, unknown> {
  time?: TimeRangeInput | null;
  sensor: string;
  origAddr?: IpRangeInput | null;
  respAddr?: IpRangeInput | null;
  origPort?: PortRangeInput | null;
  respPort?: PortRangeInput | null;
  logLevel?: string | null;
  logContents?: string | null;
  agentId?: string | null;
}

// ── Relay pagination ───────────────────────────────────────────────

/**
 * Giganto's `PageInfo`. Unlike REview's `EventConnection`, Giganto
 * connections expose **no `totalCount`**, so Prev/Next is driven purely
 * off `hasPreviousPage` / `hasNextPage` + the start/end cursors.
 */
export interface PageInfo {
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

export interface ConnRawEventEdge {
  node: ConnRawEvent;
  cursor: string;
}

export interface ConnRawEventConnection {
  pageInfo: PageInfo;
  edges: ConnRawEventEdge[];
}

// ── Conn record ────────────────────────────────────────────────────

/**
 * `ConnRawEvent` — a single Giganto connection record. Field types are
 * verified against the 0.27.0 SDL:
 *
 *   - `origAddr` / `respAddr` are IP **strings**, not numeric.
 *   - `origPort` / `respPort` / `proto` are `Int` (proto is the IP
 *     protocol number — TCP 6 / UDP 17).
 *   - `duration` is nanoseconds, serialized as a string
 *     (`StringNumberI64`).
 *   - byte / packet counts are `StringNumberU64` strings.
 */
export interface ConnRawEvent {
  time: string;
  origAddr: string;
  origPort: number;
  respAddr: string;
  respPort: number;
  proto: number;
  connState: string;
  startTime: string;
  duration: string;
  service: string;
  origBytes: string;
  respBytes: string;
  origPkts: string;
  respPkts: string;
  origL2Bytes: string;
  respL2Bytes: string;
}

// ── Statistics (aggregation chart) ─────────────────────────────────

/**
 * `statistics` query variables. `sensors` is required (`[String!]!`);
 * `time` and `protocols` are optional and emitted only when set.
 * `requestFromPeer` is left unset (defaults server-side).
 */
export interface StatisticsVariables extends Record<string, unknown> {
  sensors: string[];
  time?: TimeRangeInput | null;
  protocols?: string[] | null;
}

/**
 * `StatisticsDetail` — per-protocol metrics within one timestamp
 * bucket. Field types are verified against the 0.27.0 SDL:
 *
 *   - `bps` / `pps` / `eps` are `Float` and **nullable**.
 *   - `count` / `size` are `StringNumberU64` and **nullable**; they can
 *     exceed `Number.MAX_SAFE_INTEGER`, so they stay strings here and
 *     are parsed BigInt-safe before charting.
 */
export interface StatisticsDetail {
  protocol: string;
  bps: number | null;
  pps: number | null;
  eps: number | null;
  count: string | null;
  size: string | null;
}

/**
 * `StatisticsInfo` — one timestamp bucket. `timestamp` is
 * `StringNumberI64!`: Giganto emits the stored i64 key as-is, in
 * **epoch nanoseconds** (e.g. `"1709528767000000000"`), so it stays a
 * string and is converted from nanoseconds before plotting.
 */
export interface StatisticsInfo {
  timestamp: string;
  detail: StatisticsDetail[];
}

/** `StatisticsRawEvent` — one sensor's full statistics timeline. */
export interface StatisticsRawEvent {
  sensor: string;
  stats: StatisticsInfo[];
}

// ── Operation result envelopes (match the `.graphql` operations) ────

export interface ConnRawEventsResult {
  connRawEvents: ConnRawEventConnection;
}

export interface EventSensorsResult {
  sensors: string[];
}

export interface StatisticsResult {
  statistics: StatisticsRawEvent[];
}
