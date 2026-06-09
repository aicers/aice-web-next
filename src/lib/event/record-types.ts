/**
 * Registry of Giganto record types selectable in the Event menu. E0
 * shipped the `conn` network slice; E2 adds the 14 Sysmon / Windows
 * endpoint types. The full record metadata (family, table/detail field
 * definitions) lives in {@link ./records}; this module owns only the id
 * list and its coercion helpers so it stays a tiny, dependency-free
 * source of the {@link RecordTypeId} union.
 *
 * The `id` doubles as the URL value and the i18n key suffix
 * (`event.recordTypes.<id>`). Network ids stay lowercase slugs; the
 * sysmon ids are the verbatim Giganto query (connection) field names —
 * including the deliberately doubled `Event` in `pipeEventEvents` /
 * `dnsQueryEvents` and the `networkConnectEvents` → `NetworkConnectionEvent`
 * mapping — so the data layer can key the query and result envelope off
 * the id directly.
 */
export const RECORD_TYPE_IDS = [
  "conn",
  "processCreateEvents",
  "fileCreateTimeEvents",
  "processTerminateEvents",
  "imageLoadEvents",
  "fileCreateEvents",
  "networkConnectEvents",
  "registryValueSetEvents",
  "registryKeyRenameEvents",
  "fileCreateStreamHashEvents",
  "pipeEventEvents",
  "dnsQueryEvents",
  "fileDeleteEvents",
  "processTamperEvents",
  "fileDeleteDetectedEvents",
] as const;

export type RecordTypeId = (typeof RECORD_TYPE_IDS)[number];

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
