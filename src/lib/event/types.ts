/**
 * Hand-written result and input types mirroring the Giganto 0.27.0 SDL
 * (`schemas/giganto.graphql`) for the Event-menu data layer.
 *
 * Kept hand-written (not codegen'd) to match the Node/Triage feature
 * libs. The 64-bit numeric scalars Giganto serializes as strings —
 * `StringNumberU64` / `StringNumberI64` (E0) and the `StringNumberU32` /
 * `StringNumberUsize` variants E1 adds — are all typed as `string` here
 * and must never be cast to a JS number, or precision is lost above
 * 2^53. The descriptor scalar tables in `descriptors.ts` are the single
 * source that pins each field to one of these scalar kinds, and the
 * parametrized test cross-checks both against these interfaces.
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

/** A single Relay edge over any network raw-event node. */
export interface RawEventEdge<T> {
  node: T;
  cursor: string;
}

/**
 * A Relay cursor connection over any network raw-event type. Every
 * `<type>RawEvents` query selects the same `pageInfo` + `edges` shape,
 * so the pagination layer and the generic result list are type-shared
 * across all 20 record types.
 */
export interface RawEventConnection<T> {
  pageInfo: PageInfo;
  edges: RawEventEdge<T>[];
}

// ── Nested sub-records ─────────────────────────────────────────────

/** A single DCE/RPC bind context (`DceRpcRawEvent.context`). */
export interface DceRpcContextRawEvent {
  id: number;
  abstractSyntax: string;
  abstractMajor: number;
  abstractMinor: number;
  transferSyntax: string;
  transferMajor: number;
  transferMinor: number;
  acceptance: number;
  reason: number;
}

/** A single FTP command + response pair (`FtpRawEvent.commands`). */
export interface FtpCommandRawEvent {
  command: string;
  replyCode: string;
  replyMsg: string;
  dataPassive: boolean;
  dataOrigAddr: string;
  dataRespAddr: string;
  dataRespPort: number;
  file: string;
  fileSize: string;
  fileId: string;
}

/** A single DHCP option (`DhcpRawEvent.options`). */
export interface DhcpOptionRawEvent {
  code: number;
  value: number[];
}

// ── Network record types ───────────────────────────────────────────
//
// Each interface lists the exact field set of the matching Giganto
// type. All share the 12-field header (`time`, `origAddr`, `origPort`,
// `respAddr`, `respPort`, `proto`, `startTime`, `duration`, `origPkts`,
// `respPkts`, `origL2Bytes`, `respL2Bytes`) except `IcmpRawEvent`,
// which has no ports. `origBytes` / `respBytes` are Conn-specific.

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

export interface DnsRawEvent {
  time: string;
  origAddr: string;
  origPort: number;
  respAddr: string;
  respPort: number;
  proto: number;
  startTime: string;
  duration: string;
  origPkts: string;
  respPkts: string;
  origL2Bytes: string;
  respL2Bytes: string;
  query: string;
  answer: string[];
  transId: number;
  rtt: string;
  qclass: number;
  qtype: number;
  rcode: number;
  aaFlag: boolean;
  tcFlag: boolean;
  rdFlag: boolean;
  raFlag: boolean;
  ttl: number[];
}

/**
 * `MalformedDnsRawEvent` is **not** shaped like `DnsRawEvent`: no
 * `query` / `answer` / `rcode`, but DNS-header counts plus raw-byte
 * payloads. `queryBytes` / `respBytes` are `StringNumberU64` strings (not
 * `[Int!]!`); `queryCount` / `respCount` are `StringNumberU32` strings;
 * `queryBody` / `respBody` are `[[Int!]!]!` arrays of byte arrays.
 */
export interface MalformedDnsRawEvent {
  time: string;
  origAddr: string;
  origPort: number;
  respAddr: string;
  respPort: number;
  proto: number;
  startTime: string;
  duration: string;
  origPkts: string;
  respPkts: string;
  origL2Bytes: string;
  respL2Bytes: string;
  transId: number;
  flags: number;
  questionCount: number;
  answerCount: number;
  authorityCount: number;
  additionalCount: number;
  queryCount: string;
  respCount: string;
  queryBytes: string;
  respBytes: string;
  queryBody: number[][];
  respBody: number[][];
}

export interface HttpRawEvent {
  time: string;
  origAddr: string;
  origPort: number;
  respAddr: string;
  respPort: number;
  proto: number;
  startTime: string;
  duration: string;
  origPkts: string;
  respPkts: string;
  origL2Bytes: string;
  respL2Bytes: string;
  method: string;
  host: string;
  uri: string;
  referer: string;
  version: string;
  userAgent: string;
  requestLen: string;
  responseLen: string;
  statusCode: number;
  statusMsg: string;
  username: string;
  password: string;
  cookie: string;
  contentEncoding: string;
  contentType: string;
  cacheControl: string;
  filenames: string[];
  mimeTypes: string[];
  body: number[];
  state: string;
}

export interface RdpRawEvent {
  time: string;
  origAddr: string;
  origPort: number;
  respAddr: string;
  respPort: number;
  proto: number;
  startTime: string;
  duration: string;
  origPkts: string;
  respPkts: string;
  origL2Bytes: string;
  respL2Bytes: string;
  cookie: string;
}

export interface SmtpRawEvent {
  time: string;
  origAddr: string;
  origPort: number;
  respAddr: string;
  respPort: number;
  proto: number;
  startTime: string;
  duration: string;
  origPkts: string;
  respPkts: string;
  origL2Bytes: string;
  respL2Bytes: string;
  mailfrom: string;
  date: string;
  from: string;
  to: string;
  subject: string;
  agent: string;
  state: string;
}

export interface NtlmRawEvent {
  time: string;
  origAddr: string;
  origPort: number;
  respAddr: string;
  respPort: number;
  proto: number;
  startTime: string;
  duration: string;
  origPkts: string;
  respPkts: string;
  origL2Bytes: string;
  respL2Bytes: string;
  username: string;
  hostname: string;
  domainname: string;
  success: string;
  protocol: string;
}

export interface KerberosRawEvent {
  time: string;
  origAddr: string;
  origPort: number;
  respAddr: string;
  respPort: number;
  proto: number;
  startTime: string;
  duration: string;
  origPkts: string;
  respPkts: string;
  origL2Bytes: string;
  respL2Bytes: string;
  clientTime: string;
  serverTime: string;
  errorCode: string;
  clientRealm: string;
  cnameType: number;
  cname: string[];
  realm: string;
  snameType: number;
  sname: string[];
}

export interface SshRawEvent {
  time: string;
  origAddr: string;
  origPort: number;
  respAddr: string;
  respPort: number;
  proto: number;
  startTime: string;
  duration: string;
  origPkts: string;
  respPkts: string;
  origL2Bytes: string;
  respL2Bytes: string;
  client: string;
  server: string;
  cipherAlg: string;
  macAlg: string;
  compressionAlg: string;
  kexAlg: string;
  hostKeyAlg: string;
  hasshAlgorithms: string;
  hassh: string;
  hasshServerAlgorithms: string;
  hasshServer: string;
  clientShka: string;
  serverShka: string;
}

export interface DceRpcRawEvent {
  time: string;
  origAddr: string;
  origPort: number;
  respAddr: string;
  respPort: number;
  proto: number;
  startTime: string;
  duration: string;
  origPkts: string;
  respPkts: string;
  origL2Bytes: string;
  respL2Bytes: string;
  context: DceRpcContextRawEvent[];
  request: string[];
}

export interface FtpRawEvent {
  time: string;
  origAddr: string;
  origPort: number;
  respAddr: string;
  respPort: number;
  proto: number;
  startTime: string;
  duration: string;
  origPkts: string;
  respPkts: string;
  origL2Bytes: string;
  respL2Bytes: string;
  user: string;
  password: string;
  commands: FtpCommandRawEvent[];
}

export interface MqttRawEvent {
  time: string;
  origAddr: string;
  origPort: number;
  respAddr: string;
  respPort: number;
  proto: number;
  startTime: string;
  duration: string;
  origPkts: string;
  respPkts: string;
  origL2Bytes: string;
  respL2Bytes: string;
  protocol: string;
  version: number;
  clientId: string;
  connackReason: number;
  subscribe: string[];
  subackReason: number[];
}

export interface LdapRawEvent {
  time: string;
  origAddr: string;
  origPort: number;
  respAddr: string;
  respPort: number;
  proto: number;
  startTime: string;
  duration: string;
  origPkts: string;
  respPkts: string;
  origL2Bytes: string;
  respL2Bytes: string;
  messageId: string;
  version: number;
  opcode: string[];
  result: string[];
  diagnosticMessage: string[];
  object: string[];
  argument: string[];
}

export interface TlsRawEvent {
  time: string;
  origAddr: string;
  origPort: number;
  respAddr: string;
  respPort: number;
  proto: number;
  startTime: string;
  duration: string;
  origPkts: string;
  respPkts: string;
  origL2Bytes: string;
  respL2Bytes: string;
  serverName: string;
  alpnProtocol: string;
  ja3: string;
  version: string;
  clientCipherSuites: number[];
  clientExtensions: number[];
  cipher: number;
  extensions: number[];
  ja3S: string;
  serial: string;
  subjectCountry: string;
  subjectOrgName: string;
  subjectCommonName: string;
  validityNotBefore: string;
  validityNotAfter: string;
  subjectAltName: string;
  issuerCountry: string;
  issuerOrgName: string;
  issuerOrgUnitName: string;
  issuerCommonName: string;
  lastAlert: number;
}

export interface SmbRawEvent {
  time: string;
  origAddr: string;
  origPort: number;
  respAddr: string;
  respPort: number;
  proto: number;
  startTime: string;
  duration: string;
  origPkts: string;
  respPkts: string;
  origL2Bytes: string;
  respL2Bytes: string;
  command: number;
  path: string;
  service: string;
  fileName: string;
  fileSize: string;
  resourceType: number;
  fid: number;
  createTime: string;
  accessTime: string;
  writeTime: string;
  changeTime: string;
}

export interface NfsRawEvent {
  time: string;
  origAddr: string;
  origPort: number;
  respAddr: string;
  respPort: number;
  proto: number;
  startTime: string;
  duration: string;
  origPkts: string;
  respPkts: string;
  origL2Bytes: string;
  respL2Bytes: string;
  readFiles: string[];
  writeFiles: string[];
}

export interface BootpRawEvent {
  time: string;
  origAddr: string;
  origPort: number;
  respAddr: string;
  respPort: number;
  proto: number;
  startTime: string;
  duration: string;
  origPkts: string;
  respPkts: string;
  origL2Bytes: string;
  respL2Bytes: string;
  op: number;
  htype: number;
  hops: number;
  xid: string;
  ciaddr: string;
  yiaddr: string;
  siaddr: string;
  giaddr: string;
  chaddr: number[];
  sname: string;
  file: string;
}

export interface DhcpRawEvent {
  time: string;
  origAddr: string;
  origPort: number;
  respAddr: string;
  respPort: number;
  proto: number;
  startTime: string;
  duration: string;
  origPkts: string;
  respPkts: string;
  origL2Bytes: string;
  respL2Bytes: string;
  msgType: number;
  ciaddr: string;
  yiaddr: string;
  siaddr: string;
  giaddr: string;
  subnetMask: string;
  router: string[];
  domainNameServer: string[];
  reqIpAddr: string;
  leaseTime: string;
  serverId: string;
  paramReqList: number[];
  message: string;
  renewalTime: string;
  rebindingTime: string;
  classId: number[];
  clientIdType: number;
  clientId: number[];
  options: DhcpOptionRawEvent[];
}

export interface RadiusRawEvent {
  time: string;
  origAddr: string;
  origPort: number;
  respAddr: string;
  respPort: number;
  proto: number;
  startTime: string;
  duration: string;
  origPkts: string;
  respPkts: string;
  origL2Bytes: string;
  respL2Bytes: string;
  id: number;
  code: number;
  respCode: number;
  auth: string;
  respAuth: string;
  userName: number[];
  userPasswd: number[];
  chapPasswd: number[];
  nasIp: string;
  nasPort: string;
  state: number[];
  nasId: number[];
  nasPortType: string;
  message: string;
}

/**
 * `IcmpRawEvent` — the header minus `origPort` / `respPort` (ICMP has
 * no ports), plus the ICMP-specific fields. The filter strips port
 * inputs for this type (see `toNetworkFilter`).
 */
export interface IcmpRawEvent {
  time: string;
  origAddr: string;
  respAddr: string;
  proto: number;
  startTime: string;
  duration: string;
  origPkts: string;
  respPkts: string;
  origL2Bytes: string;
  respL2Bytes: string;
  icmpType: number;
  icmpCode: number;
  id: number;
  seqNum: number;
  dataLen: number;
  payload: number[];
}

// ── Sysmon / endpoint record types ─────────────────────────────────
//
// The 14 Giganto Sysmon / Windows endpoint event types. They share a
// common header — `time`, `agentName`, `agentId`, `processGuid`,
// `processId`, `image`, `user` — and carry no ports. `processId` and the
// other `StringNumberU32` scalars (`logonId`, `terminalSessionId`,
// `parentProcessId`, `queryStatus`) are serialized as strings and must
// never be cast to a JS number. List fields keep their exact SDL name
// (`hashes`, but `hash` singular on FileCreateStreamHashEvent, and
// `queryResults` on DnsEventEvent).

/** `ProcessCreateEvent` — `processCreateEvents` query. */
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

/** `FileCreationTimeChangedEvent` — `fileCreateTimeEvents` query. */
export interface FileCreateTimeEvent {
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

/** `ProcessTerminatedEvent` — `processTerminateEvents` query. */
export interface ProcessTerminateEvent {
  time: string;
  agentName: string;
  agentId: string;
  processGuid: string;
  processId: string;
  image: string;
  user: string;
}

/** `ImageLoadedEvent` — `imageLoadEvents` query. */
export interface ImageLoadEvent {
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

/** `FileCreateEvent` — `fileCreateEvents` query. */
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

/** `NetworkConnectionEvent` — `networkConnectEvents` query. */
export interface NetworkConnectEvent {
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

/** `RegistryValueSetEvent` — `registryValueSetEvents` query. */
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

/** `RegistryKeyValueRenameEvent` — `registryKeyRenameEvents` query. */
export interface RegistryKeyRenameEvent {
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

/** `FileCreateStreamHashEvent` — `fileCreateStreamHashEvents` query. */
export interface FileCreateStreamHashEvent {
  time: string;
  agentName: string;
  agentId: string;
  processGuid: string;
  processId: string;
  image: string;
  targetFilename: string;
  creationUtcTime: string;
  // Note: singular `hash` (not `hashes`) per the SDL.
  hash: string[];
  contents: string;
  user: string;
}

/** `PipeEventEvent` — `pipeEventEvents` query. */
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

/** `DnsEventEvent` — `dnsQueryEvents` query. */
export interface DnsQueryEvent {
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

/** `FileDeleteEvent` — `fileDeleteEvents` query. */
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

/** `ProcessTamperingEvent` — `processTamperEvents` query. */
export interface ProcessTamperEvent {
  time: string;
  agentName: string;
  agentId: string;
  processGuid: string;
  processId: string;
  image: string;
  tamperType: string;
  user: string;
}

/** `FileDeleteDetectedEvent` — `fileDeleteDetectedEvents` query. */
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

/** Union of every raw-event node the Event menu can browse. */
export type RawEvent =
  | ConnRawEvent
  | DnsRawEvent
  | MalformedDnsRawEvent
  | HttpRawEvent
  | RdpRawEvent
  | SmtpRawEvent
  | NtlmRawEvent
  | KerberosRawEvent
  | SshRawEvent
  | DceRpcRawEvent
  | FtpRawEvent
  | MqttRawEvent
  | LdapRawEvent
  | TlsRawEvent
  | SmbRawEvent
  | NfsRawEvent
  | BootpRawEvent
  | DhcpRawEvent
  | RadiusRawEvent
  | IcmpRawEvent
  | ProcessCreateEvent
  | FileCreateTimeEvent
  | ProcessTerminateEvent
  | ImageLoadEvent
  | FileCreateEvent
  | NetworkConnectEvent
  | RegistryValueSetEvent
  | RegistryKeyRenameEvent
  | FileCreateStreamHashEvent
  | PipeEventEvent
  | DnsQueryEvent
  | FileDeleteEvent
  | ProcessTamperEvent
  | FileDeleteDetectedEvent;

/**
 * Every scalar shape a record field can hold once Giganto serializes
 * it. The descriptor-driven renderer reads `record[field.key]` and
 * narrows on the field's declared scalar kind.
 */
export type RawEventFieldValue =
  | string
  | number
  | boolean
  | string[]
  | number[]
  | number[][]
  | DceRpcContextRawEvent[]
  | FtpCommandRawEvent[]
  | DhcpOptionRawEvent[];

// ── Conn connection alias ──────────────────────────────────────────

export type ConnRawEventConnection = RawEventConnection<ConnRawEvent>;

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

// ── Periodic time series (E5 Part 2) ───────────────────────────────

/**
 * `TimeSeriesFilter` input for `periodicTimeSeries`. `id` is required
 * (the sampling policy to chart); `time` is an optional window. Unlike
 * the Statistics filter there is no sensor/protocol list — a time series
 * is keyed solely by its policy id.
 */
export interface TimeSeriesFilterInput extends Record<string, unknown> {
  id: string;
  time?: TimeRangeInput | null;
}

/**
 * `periodicTimeSeries` query variables. `filter` is required; the Relay
 * pagination args are optional and emitted as explicit `null` when
 * unset (matching the raw-event search dispatch).
 */
export interface PeriodicTimeSeriesVariables extends Record<string, unknown> {
  filter: TimeSeriesFilterInput;
  first?: number | null;
  after?: string | null;
  last?: number | null;
  before?: string | null;
}

/**
 * `TimeSeries` node — one chunk of a policy's series. `start` is a
 * `DateTime!` origin; `data` is a plain `[Float!]!` numeric series (no
 * 64-bit string scalars, so the values are safe JS numbers). `id` echoes
 * the requested sampling policy id.
 */
export interface TimeSeriesNode {
  start: string;
  id: string;
  data: number[];
}

/** `TimeSeriesConnection` — the nodes selection plus Relay page info. */
export interface TimeSeriesConnection {
  pageInfo: PageInfo;
  nodes: TimeSeriesNode[];
}

export interface PeriodicTimeSeriesResult {
  periodicTimeSeries: TimeSeriesConnection;
}

// ── Sampling policies (REview — `id` selector source) ──────────────

/**
 * `SamplingPolicy` — the subset selected for the Periodic Time Series
 * `id` selector. `id` is `ID!` (the selector value, serialized as a
 * string); `name` is the option label.
 */
export interface SamplingPolicy {
  id: string;
  name: string;
}

export interface SamplingPolicyConnection {
  pageInfo: PageInfo;
  nodes: SamplingPolicy[];
}

export interface SamplingPolicyListResult {
  samplingPolicyList: SamplingPolicyConnection;
}
