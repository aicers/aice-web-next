/**
 * Client-safe registry of the Event-menu Giganto record types.
 *
 * This module carries **only** metadata (ids, families, field
 * definitions with formatting kinds) so it can be imported from client
 * components. The server-only query `DocumentNode`s and the dispatch map
 * live in `queries.ts` / `server-actions.ts` — keeping the `.graphql`
 * loader out of the client bundle.
 *
 * Each sysmon type is defined once here and drives the generic table and
 * detail renderers, so adding a type is a data edit (plus its `.graphql`
 * document), not a new component.
 *
 * NOTE: this file is generated-shaped but hand-maintained. The field
 * lists mirror `schemas/giganto.graphql` verbatim; the schema-validation
 * gate and the parametrized record test enforce that the `detailFields`
 * here stay in lockstep with each operation's `.graphql` selection set.
 */

import type { RecordTypeId } from "./record-types";

/**
 * A record family selects which `NetworkFilter` fields are meaningful:
 * `network` (Conn) filters by IP/port ranges; `sysmon` (Windows endpoint
 * events) filters by `agentId`. The family drives the bidirectional
 * stale-filter allow-list in `toNetworkFilter`.
 */
export type RecordFamily = "network" | "sysmon";

/**
 * How the generic renderer formats a field value:
 * - `datetime`: a `DateTime!` string, shown verbatim (consistent with E0).
 * - `text`: a `String!` or `StringNumber*` scalar, shown as-is — the
 *   string-serialized 32/64-bit numbers are **never** coerced to a JS
 *   number.
 * - `list`: a `[String!]!` field, joined for display.
 * - `boolean`: a `Boolean!` field, shown as a locale-aware label.
 */
export type FieldKind = "datetime" | "text" | "list" | "boolean";

export interface FieldDef {
  /** SDL field name; doubles as the `event.fields.<name>` i18n key. */
  readonly name: string;
  readonly kind: FieldKind;
}

export interface RecordDef {
  /** URL value and `event.recordTypes.<id>` i18n key. */
  readonly id: RecordTypeId;
  readonly family: RecordFamily;
  /** SDL object type name (e.g. `ProcessCreateEvent`). */
  readonly recordTypeName: string;
  /** PascalCase GraphQL operation name (e.g. `ProcessCreateEvents`). */
  readonly operationName: string;
  /** Compact column set for the results table. */
  readonly tableFields: readonly FieldDef[];
  /** Full field set (SDL order) for the row-detail view. */
  readonly detailFields: readonly FieldDef[];
}

/**
 * The Conn vertical slice (E0) is the sole `network`-family record and
 * keeps its bespoke table/detail components (endpoint, protocol, byte
 * count, and duration formatting), so it carries no generic field
 * definitions here — only its family for the filter allow-list.
 */
const CONN_RECORD: RecordDef = {
  id: "conn",
  family: "network",
  recordTypeName: "ConnRawEvent",
  operationName: "ConnRawEvents",
  tableFields: [],
  detailFields: [],
};

/** The 14 Sysmon / Windows endpoint record definitions (E2). */
export const SYSMON_RECORD_DEFS: readonly RecordDef[] = [
  {
    id: "processCreateEvents",
    family: "sysmon",
    recordTypeName: "ProcessCreateEvent",
    operationName: "ProcessCreateEvents",
    tableFields: [
      { name: "time", kind: "datetime" },
      { name: "agentName", kind: "text" },
      { name: "image", kind: "text" },
      { name: "commandLine", kind: "text" },
      { name: "user", kind: "text" },
    ],
    detailFields: [
      { name: "time", kind: "datetime" },
      { name: "agentName", kind: "text" },
      { name: "agentId", kind: "text" },
      { name: "processGuid", kind: "text" },
      { name: "processId", kind: "text" },
      { name: "image", kind: "text" },
      { name: "fileVersion", kind: "text" },
      { name: "description", kind: "text" },
      { name: "product", kind: "text" },
      { name: "company", kind: "text" },
      { name: "originalFileName", kind: "text" },
      { name: "commandLine", kind: "text" },
      { name: "currentDirectory", kind: "text" },
      { name: "user", kind: "text" },
      { name: "logonGuid", kind: "text" },
      { name: "logonId", kind: "text" },
      { name: "terminalSessionId", kind: "text" },
      { name: "integrityLevel", kind: "text" },
      { name: "hashes", kind: "list" },
      { name: "parentProcessGuid", kind: "text" },
      { name: "parentProcessId", kind: "text" },
      { name: "parentImage", kind: "text" },
      { name: "parentCommandLine", kind: "text" },
      { name: "parentUser", kind: "text" },
    ],
  },
  {
    id: "fileCreateTimeEvents",
    family: "sysmon",
    recordTypeName: "FileCreationTimeChangedEvent",
    operationName: "FileCreateTimeEvents",
    tableFields: [
      { name: "time", kind: "datetime" },
      { name: "agentName", kind: "text" },
      { name: "image", kind: "text" },
      { name: "targetFilename", kind: "text" },
      { name: "user", kind: "text" },
    ],
    detailFields: [
      { name: "time", kind: "datetime" },
      { name: "agentName", kind: "text" },
      { name: "agentId", kind: "text" },
      { name: "processGuid", kind: "text" },
      { name: "processId", kind: "text" },
      { name: "image", kind: "text" },
      { name: "targetFilename", kind: "text" },
      { name: "creationUtcTime", kind: "datetime" },
      { name: "previousCreationUtcTime", kind: "datetime" },
      { name: "user", kind: "text" },
    ],
  },
  {
    id: "processTerminateEvents",
    family: "sysmon",
    recordTypeName: "ProcessTerminatedEvent",
    operationName: "ProcessTerminateEvents",
    tableFields: [
      { name: "time", kind: "datetime" },
      { name: "agentName", kind: "text" },
      { name: "processId", kind: "text" },
      { name: "image", kind: "text" },
      { name: "user", kind: "text" },
    ],
    detailFields: [
      { name: "time", kind: "datetime" },
      { name: "agentName", kind: "text" },
      { name: "agentId", kind: "text" },
      { name: "processGuid", kind: "text" },
      { name: "processId", kind: "text" },
      { name: "image", kind: "text" },
      { name: "user", kind: "text" },
    ],
  },
  {
    id: "imageLoadEvents",
    family: "sysmon",
    recordTypeName: "ImageLoadedEvent",
    operationName: "ImageLoadEvents",
    tableFields: [
      { name: "time", kind: "datetime" },
      { name: "agentName", kind: "text" },
      { name: "image", kind: "text" },
      { name: "imageLoaded", kind: "text" },
      { name: "user", kind: "text" },
    ],
    detailFields: [
      { name: "time", kind: "datetime" },
      { name: "agentName", kind: "text" },
      { name: "agentId", kind: "text" },
      { name: "processGuid", kind: "text" },
      { name: "processId", kind: "text" },
      { name: "image", kind: "text" },
      { name: "imageLoaded", kind: "text" },
      { name: "fileVersion", kind: "text" },
      { name: "description", kind: "text" },
      { name: "product", kind: "text" },
      { name: "company", kind: "text" },
      { name: "originalFileName", kind: "text" },
      { name: "hashes", kind: "list" },
      { name: "signed", kind: "boolean" },
      { name: "signature", kind: "text" },
      { name: "signatureStatus", kind: "text" },
      { name: "user", kind: "text" },
    ],
  },
  {
    id: "fileCreateEvents",
    family: "sysmon",
    recordTypeName: "FileCreateEvent",
    operationName: "FileCreateEvents",
    tableFields: [
      { name: "time", kind: "datetime" },
      { name: "agentName", kind: "text" },
      { name: "image", kind: "text" },
      { name: "targetFilename", kind: "text" },
      { name: "user", kind: "text" },
    ],
    detailFields: [
      { name: "time", kind: "datetime" },
      { name: "agentName", kind: "text" },
      { name: "agentId", kind: "text" },
      { name: "processGuid", kind: "text" },
      { name: "processId", kind: "text" },
      { name: "image", kind: "text" },
      { name: "targetFilename", kind: "text" },
      { name: "creationUtcTime", kind: "datetime" },
      { name: "user", kind: "text" },
    ],
  },
  {
    id: "networkConnectEvents",
    family: "sysmon",
    recordTypeName: "NetworkConnectionEvent",
    operationName: "NetworkConnectEvents",
    tableFields: [
      { name: "time", kind: "datetime" },
      { name: "agentName", kind: "text" },
      { name: "image", kind: "text" },
      { name: "sourceIp", kind: "text" },
      { name: "destinationIp", kind: "text" },
      { name: "user", kind: "text" },
    ],
    detailFields: [
      { name: "time", kind: "datetime" },
      { name: "agentName", kind: "text" },
      { name: "agentId", kind: "text" },
      { name: "processGuid", kind: "text" },
      { name: "processId", kind: "text" },
      { name: "image", kind: "text" },
      { name: "user", kind: "text" },
      { name: "protocol", kind: "text" },
      { name: "initiated", kind: "boolean" },
      { name: "sourceIsIpv6", kind: "boolean" },
      { name: "sourceIp", kind: "text" },
      { name: "sourceHostname", kind: "text" },
      { name: "sourcePort", kind: "text" },
      { name: "sourcePortName", kind: "text" },
      { name: "destinationIsIpv6", kind: "boolean" },
      { name: "destinationIp", kind: "text" },
      { name: "destinationHostname", kind: "text" },
      { name: "destinationPort", kind: "text" },
      { name: "destinationPortName", kind: "text" },
    ],
  },
  {
    id: "registryValueSetEvents",
    family: "sysmon",
    recordTypeName: "RegistryValueSetEvent",
    operationName: "RegistryValueSetEvents",
    tableFields: [
      { name: "time", kind: "datetime" },
      { name: "agentName", kind: "text" },
      { name: "image", kind: "text" },
      { name: "targetObject", kind: "text" },
      { name: "user", kind: "text" },
    ],
    detailFields: [
      { name: "time", kind: "datetime" },
      { name: "agentName", kind: "text" },
      { name: "agentId", kind: "text" },
      { name: "eventType", kind: "text" },
      { name: "processGuid", kind: "text" },
      { name: "processId", kind: "text" },
      { name: "image", kind: "text" },
      { name: "targetObject", kind: "text" },
      { name: "details", kind: "text" },
      { name: "user", kind: "text" },
    ],
  },
  {
    id: "registryKeyRenameEvents",
    family: "sysmon",
    recordTypeName: "RegistryKeyValueRenameEvent",
    operationName: "RegistryKeyRenameEvents",
    tableFields: [
      { name: "time", kind: "datetime" },
      { name: "agentName", kind: "text" },
      { name: "image", kind: "text" },
      { name: "targetObject", kind: "text" },
      { name: "newName", kind: "text" },
      { name: "user", kind: "text" },
    ],
    detailFields: [
      { name: "time", kind: "datetime" },
      { name: "agentName", kind: "text" },
      { name: "agentId", kind: "text" },
      { name: "eventType", kind: "text" },
      { name: "processGuid", kind: "text" },
      { name: "processId", kind: "text" },
      { name: "image", kind: "text" },
      { name: "targetObject", kind: "text" },
      { name: "newName", kind: "text" },
      { name: "user", kind: "text" },
    ],
  },
  {
    id: "fileCreateStreamHashEvents",
    family: "sysmon",
    recordTypeName: "FileCreateStreamHashEvent",
    operationName: "FileCreateStreamHashEvents",
    tableFields: [
      { name: "time", kind: "datetime" },
      { name: "agentName", kind: "text" },
      { name: "image", kind: "text" },
      { name: "targetFilename", kind: "text" },
      { name: "user", kind: "text" },
    ],
    detailFields: [
      { name: "time", kind: "datetime" },
      { name: "agentName", kind: "text" },
      { name: "agentId", kind: "text" },
      { name: "processGuid", kind: "text" },
      { name: "processId", kind: "text" },
      { name: "image", kind: "text" },
      { name: "targetFilename", kind: "text" },
      { name: "creationUtcTime", kind: "datetime" },
      { name: "hash", kind: "list" },
      { name: "contents", kind: "text" },
      { name: "user", kind: "text" },
    ],
  },
  {
    id: "pipeEventEvents",
    family: "sysmon",
    recordTypeName: "PipeEventEvent",
    operationName: "PipeEventEvents",
    tableFields: [
      { name: "time", kind: "datetime" },
      { name: "agentName", kind: "text" },
      { name: "image", kind: "text" },
      { name: "pipeName", kind: "text" },
      { name: "user", kind: "text" },
    ],
    detailFields: [
      { name: "time", kind: "datetime" },
      { name: "agentName", kind: "text" },
      { name: "agentId", kind: "text" },
      { name: "eventType", kind: "text" },
      { name: "processGuid", kind: "text" },
      { name: "processId", kind: "text" },
      { name: "pipeName", kind: "text" },
      { name: "image", kind: "text" },
      { name: "user", kind: "text" },
    ],
  },
  {
    id: "dnsQueryEvents",
    family: "sysmon",
    recordTypeName: "DnsEventEvent",
    operationName: "DnsQueryEvents",
    tableFields: [
      { name: "time", kind: "datetime" },
      { name: "agentName", kind: "text" },
      { name: "image", kind: "text" },
      { name: "queryName", kind: "text" },
      { name: "user", kind: "text" },
    ],
    detailFields: [
      { name: "time", kind: "datetime" },
      { name: "agentName", kind: "text" },
      { name: "agentId", kind: "text" },
      { name: "processGuid", kind: "text" },
      { name: "processId", kind: "text" },
      { name: "queryName", kind: "text" },
      { name: "queryStatus", kind: "text" },
      { name: "queryResults", kind: "list" },
      { name: "image", kind: "text" },
      { name: "user", kind: "text" },
    ],
  },
  {
    id: "fileDeleteEvents",
    family: "sysmon",
    recordTypeName: "FileDeleteEvent",
    operationName: "FileDeleteEvents",
    tableFields: [
      { name: "time", kind: "datetime" },
      { name: "agentName", kind: "text" },
      { name: "image", kind: "text" },
      { name: "targetFilename", kind: "text" },
      { name: "user", kind: "text" },
    ],
    detailFields: [
      { name: "time", kind: "datetime" },
      { name: "agentName", kind: "text" },
      { name: "agentId", kind: "text" },
      { name: "processGuid", kind: "text" },
      { name: "processId", kind: "text" },
      { name: "user", kind: "text" },
      { name: "image", kind: "text" },
      { name: "targetFilename", kind: "text" },
      { name: "hashes", kind: "list" },
      { name: "isExecutable", kind: "boolean" },
      { name: "archived", kind: "boolean" },
    ],
  },
  {
    id: "processTamperEvents",
    family: "sysmon",
    recordTypeName: "ProcessTamperingEvent",
    operationName: "ProcessTamperEvents",
    tableFields: [
      { name: "time", kind: "datetime" },
      { name: "agentName", kind: "text" },
      { name: "image", kind: "text" },
      { name: "tamperType", kind: "text" },
      { name: "user", kind: "text" },
    ],
    detailFields: [
      { name: "time", kind: "datetime" },
      { name: "agentName", kind: "text" },
      { name: "agentId", kind: "text" },
      { name: "processGuid", kind: "text" },
      { name: "processId", kind: "text" },
      { name: "image", kind: "text" },
      { name: "tamperType", kind: "text" },
      { name: "user", kind: "text" },
    ],
  },
  {
    id: "fileDeleteDetectedEvents",
    family: "sysmon",
    recordTypeName: "FileDeleteDetectedEvent",
    operationName: "FileDeleteDetectedEvents",
    tableFields: [
      { name: "time", kind: "datetime" },
      { name: "agentName", kind: "text" },
      { name: "image", kind: "text" },
      { name: "targetFilename", kind: "text" },
      { name: "user", kind: "text" },
    ],
    detailFields: [
      { name: "time", kind: "datetime" },
      { name: "agentName", kind: "text" },
      { name: "agentId", kind: "text" },
      { name: "processGuid", kind: "text" },
      { name: "processId", kind: "text" },
      { name: "user", kind: "text" },
      { name: "image", kind: "text" },
      { name: "targetFilename", kind: "text" },
      { name: "hashes", kind: "list" },
      { name: "isExecutable", kind: "boolean" },
    ],
  },
];

/** Every record definition, keyed by id. */
export const RECORD_DEFS: Readonly<Record<RecordTypeId, RecordDef>> = {
  conn: CONN_RECORD,
  processCreateEvents: SYSMON_RECORD_DEFS[0],
  fileCreateTimeEvents: SYSMON_RECORD_DEFS[1],
  processTerminateEvents: SYSMON_RECORD_DEFS[2],
  imageLoadEvents: SYSMON_RECORD_DEFS[3],
  fileCreateEvents: SYSMON_RECORD_DEFS[4],
  networkConnectEvents: SYSMON_RECORD_DEFS[5],
  registryValueSetEvents: SYSMON_RECORD_DEFS[6],
  registryKeyRenameEvents: SYSMON_RECORD_DEFS[7],
  fileCreateStreamHashEvents: SYSMON_RECORD_DEFS[8],
  pipeEventEvents: SYSMON_RECORD_DEFS[9],
  dnsQueryEvents: SYSMON_RECORD_DEFS[10],
  fileDeleteEvents: SYSMON_RECORD_DEFS[11],
  processTamperEvents: SYSMON_RECORD_DEFS[12],
  fileDeleteDetectedEvents: SYSMON_RECORD_DEFS[13],
};

/** Family of a record type (defaults to `sysmon` for unknown ids). */
export function recordFamily(id: RecordTypeId): RecordFamily {
  return RECORD_DEFS[id]?.family ?? "sysmon";
}

/** Record definition for a record type. */
export function recordDef(id: RecordTypeId): RecordDef {
  return RECORD_DEFS[id];
}
