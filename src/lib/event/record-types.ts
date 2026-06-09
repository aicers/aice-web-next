/**
 * Registry of Giganto network record types selectable in the Event
 * menu. E0 shipped `conn`; E1 adds the remaining 19 members of the
 * `NetworkRawEvents` union. The order here is the order shown in the
 * record-type selector.
 *
 * Each `id` is the camelCase slug of the matching `<id>RawEvents` query
 * and doubles as the URL value and the i18n key suffix
 * (`event.recordTypes.<id>`), so it stays a stable identifier.
 */
export const RECORD_TYPE_IDS = [
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
