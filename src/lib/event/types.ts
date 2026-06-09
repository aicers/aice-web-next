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

/** Union of every network raw-event node the Event menu can browse. */
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
  | IcmpRawEvent;

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

// ── Conn back-compat aliases (E0 call sites) ───────────────────────

export type ConnRawEventEdge = RawEventEdge<ConnRawEvent>;
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
