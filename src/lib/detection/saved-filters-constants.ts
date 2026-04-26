/**
 * Constants shared between the server-only saved-filters helpers and
 * client UI (e.g. the input's `maxLength` attribute). Lives in a
 * dedicated module so the client bundle does not transitively pull
 * the server-only `pg` client through `saved-filters.ts`.
 */

/** Hard cap on the user-supplied saved-filter name length. */
export const SAVED_FILTER_NAME_MAX = 120;

/** Hard cap on the serialized `filter_json` payload size. */
export const SAVED_FILTER_JSON_MAX_BYTES = 32_768;
