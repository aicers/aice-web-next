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

// ── Operation result envelopes (match the `.graphql` operations) ────

export interface ConnRawEventsResult {
  connRawEvents: ConnRawEventConnection;
}

export interface EventSensorsResult {
  sensors: string[];
}

// ── Sysmon / Windows endpoint records (E2) ─────────────────────────

export interface ProcessCreateEvent {
  time: string;
  agentName: string;
  agentId: string;
  processGuid: string;
  processId: string;
  image: string;
  fileVersion: string;
  description: string;
  product: string;
  company: string;
  originalFileName: string;
  commandLine: string;
  currentDirectory: string;
  user: string;
  logonGuid: string;
  logonId: string;
  terminalSessionId: string;
  integrityLevel: string;
  hashes: string[];
  parentProcessGuid: string;
  parentProcessId: string;
  parentImage: string;
  parentCommandLine: string;
  parentUser: string;
}

export interface FileCreationTimeChangedEvent {
  time: string;
  agentName: string;
  agentId: string;
  processGuid: string;
  processId: string;
  image: string;
  targetFilename: string;
  creationUtcTime: string;
  previousCreationUtcTime: string;
  user: string;
}

export interface ProcessTerminatedEvent {
  time: string;
  agentName: string;
  agentId: string;
  processGuid: string;
  processId: string;
  image: string;
  user: string;
}

export interface ImageLoadedEvent {
  time: string;
  agentName: string;
  agentId: string;
  processGuid: string;
  processId: string;
  image: string;
  imageLoaded: string;
  fileVersion: string;
  description: string;
  product: string;
  company: string;
  originalFileName: string;
  hashes: string[];
  signed: boolean;
  signature: string;
  signatureStatus: string;
  user: string;
}

export interface FileCreateEvent {
  time: string;
  agentName: string;
  agentId: string;
  processGuid: string;
  processId: string;
  image: string;
  targetFilename: string;
  creationUtcTime: string;
  user: string;
}

export interface NetworkConnectionEvent {
  time: string;
  agentName: string;
  agentId: string;
  processGuid: string;
  processId: string;
  image: string;
  user: string;
  protocol: string;
  initiated: boolean;
  sourceIsIpv6: boolean;
  sourceIp: string;
  sourceHostname: string;
  sourcePort: number;
  sourcePortName: string;
  destinationIsIpv6: boolean;
  destinationIp: string;
  destinationHostname: string;
  destinationPort: number;
  destinationPortName: string;
}

export interface RegistryValueSetEvent {
  time: string;
  agentName: string;
  agentId: string;
  eventType: string;
  processGuid: string;
  processId: string;
  image: string;
  targetObject: string;
  details: string;
  user: string;
}

export interface RegistryKeyValueRenameEvent {
  time: string;
  agentName: string;
  agentId: string;
  eventType: string;
  processGuid: string;
  processId: string;
  image: string;
  targetObject: string;
  newName: string;
  user: string;
}

export interface FileCreateStreamHashEvent {
  time: string;
  agentName: string;
  agentId: string;
  processGuid: string;
  processId: string;
  image: string;
  targetFilename: string;
  creationUtcTime: string;
  hash: string[];
  contents: string;
  user: string;
}

export interface PipeEventEvent {
  time: string;
  agentName: string;
  agentId: string;
  eventType: string;
  processGuid: string;
  processId: string;
  pipeName: string;
  image: string;
  user: string;
}

export interface DnsEventEvent {
  time: string;
  agentName: string;
  agentId: string;
  processGuid: string;
  processId: string;
  queryName: string;
  queryStatus: string;
  queryResults: string[];
  image: string;
  user: string;
}

export interface FileDeleteEvent {
  time: string;
  agentName: string;
  agentId: string;
  processGuid: string;
  processId: string;
  user: string;
  image: string;
  targetFilename: string;
  hashes: string[];
  isExecutable: boolean;
  archived: boolean;
}

export interface ProcessTamperingEvent {
  time: string;
  agentName: string;
  agentId: string;
  processGuid: string;
  processId: string;
  image: string;
  tamperType: string;
  user: string;
}

export interface FileDeleteDetectedEvent {
  time: string;
  agentName: string;
  agentId: string;
  processGuid: string;
  processId: string;
  user: string;
  image: string;
  targetFilename: string;
  hashes: string[];
  isExecutable: boolean;
}

/** Union of every Sysmon record (one per E2 operation). */
export type SysmonRawEvent =
  | ProcessCreateEvent
  | FileCreationTimeChangedEvent
  | ProcessTerminatedEvent
  | ImageLoadedEvent
  | FileCreateEvent
  | NetworkConnectionEvent
  | RegistryValueSetEvent
  | RegistryKeyValueRenameEvent
  | FileCreateStreamHashEvent
  | PipeEventEvent
  | DnsEventEvent
  | FileDeleteEvent
  | ProcessTamperingEvent
  | FileDeleteDetectedEvent;

/**
 * A generic Sysmon node as the data layer carries it: the 14 operations
 * share one Relay connection shape, and the generic renderer reads
 * fields by name off this map (keys validated against the record def).
 */
export type SysmonRawEventNode = Record<
  string,
  string | string[] | boolean | number
>;

export interface SysmonRawEventEdge {
  node: SysmonRawEventNode;
  cursor: string;
}

export interface SysmonRawEventConnection {
  pageInfo: PageInfo;
  edges: SysmonRawEventEdge[];
}
