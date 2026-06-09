/**
 * Registry of Giganto network record types selectable in the Event
 * menu. E0 ships only `conn` end-to-end; later phases (E1) extend this
 * list as each `<type>RawEvents` query is wired through the data layer.
 *
 * The `id` doubles as the URL value and the i18n key suffix
 * (`event.recordTypes.<id>`), so it stays a stable lowercase slug.
 */
export const RECORD_TYPE_IDS = ["conn"] as const;

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
