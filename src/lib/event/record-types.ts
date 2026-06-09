/**
 * Registry of Giganto record types selectable in the Event menu. E0
 * shipped `conn`; E1 added the remaining 19 members of the
 * `NetworkRawEvents` union; E2 adds the 14 Sysmon / Windows endpoint
 * event types. The order here is the order shown in the record-type
 * selector — the network family first, then the sysmon family.
 *
 * For the **network** family each `id` is the camelCase slug of the
 * matching `<id>RawEvents` query. The **sysmon** queries instead end in
 * `Events` (not `RawEvents`), so a sysmon `id` is the query name minus
 * the trailing `Events` (`processCreateEvents` → `processCreate`). The
 * `id` doubles as the URL value and the i18n key suffix
 * (`event.recordTypes.<id>`), so it stays a stable identifier. The
 * exact query name lives in each descriptor's `responseKey`, since the
 * suffix differs per family.
 */
export const NETWORK_RECORD_TYPE_IDS = [
  "conn",
  "dns",
  "malformedDns",
  "http",
  "rdp",
  "smtp",
  "ntlm",
  "kerberos",
  "ssh",
  "dceRpc",
  "ftp",
  "mqtt",
  "ldap",
  "tls",
  "smb",
  "nfs",
  "bootp",
  "dhcp",
  "radius",
  "icmp",
] as const;

/**
 * The 14 Giganto Sysmon / Windows endpoint event types. Unlike the
 * network family these filter by `agentId` (not IP/port), carry no
 * ports, and their queries end in `Events`.
 */
export const SYSMON_RECORD_TYPE_IDS = [
  "processCreate",
  "fileCreateTime",
  "processTerminate",
  "imageLoad",
  "fileCreate",
  "networkConnect",
  "registryValueSet",
  "registryKeyRename",
  "fileCreateStreamHash",
  "pipeEvent",
  "dnsQuery",
  "fileDelete",
  "processTamper",
  "fileDeleteDetected",
] as const;

export const RECORD_TYPE_IDS = [
  ...NETWORK_RECORD_TYPE_IDS,
  ...SYSMON_RECORD_TYPE_IDS,
] as const;

export type RecordTypeId = (typeof RECORD_TYPE_IDS)[number];

/**
 * The two record families. They differ in how the filter maps onto
 * Giganto's `NetworkFilter`: the network family carries IP/port ranges,
 * the sysmon family carries a free-text `agentId` instead.
 */
export type RecordFamily = "network" | "sysmon";

const SYSMON_ID_SET: ReadonlySet<string> = new Set(SYSMON_RECORD_TYPE_IDS);

/** Which family a record type belongs to. */
export function recordFamily(id: RecordTypeId): RecordFamily {
  return SYSMON_ID_SET.has(id) ? "sysmon" : "network";
}

export const DEFAULT_RECORD_TYPE: RecordTypeId = "conn";

export function isRecordTypeId(value: string): value is RecordTypeId {
  return (RECORD_TYPE_IDS as readonly string[]).includes(value);
}

/**
 * Coerce an arbitrary string (e.g. a stale URL param) into a supported
 * record type, falling back to {@link DEFAULT_RECORD_TYPE}.
 */
export function coerceRecordType(value: string | undefined): RecordTypeId {
  return value !== undefined && isRecordTypeId(value)
    ? value
    : DEFAULT_RECORD_TYPE;
}
