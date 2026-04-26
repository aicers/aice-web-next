import "server-only";

import { query } from "@/lib/db/client";
import type { Filter } from "./filter";
import { coerceEventListFilterInput, coerceFilter } from "./filter-coerce";
import {
  SAVED_FILTER_JSON_MAX_BYTES,
  SAVED_FILTER_NAME_MAX,
} from "./saved-filters-constants";

export {
  SAVED_FILTER_JSON_MAX_BYTES,
  SAVED_FILTER_NAME_MAX,
} from "./saved-filters-constants";

/**
 * Personal saved filter row as exposed to the client. The persisted
 * `mode` plus `filter_json` are reassembled into a typed {@link Filter}
 * so callers can hand the value straight back to the Detection shell.
 *
 * v1 only inserts `mode = 'structured'` rows. The `mode = 'query'`
 * branch is a forward-compatibility seat: the column exists today so
 * the future search-language phase can land without a schema change,
 * and load paths must reject any other mode value gracefully.
 */
export interface SavedFilter {
  id: string;
  name: string;
  filter: Filter;
  createdAt: string;
  updatedAt: string;
}

/**
 * Marker error thrown when a `saveFilter` / `renameFilter` call
 * collides with the per-account `UNIQUE(owner_account_id, name)`
 * constraint. Server actions translate this into a structured client
 * response so the dialog can surface a "name already in use" message
 * without leaking the database error.
 */
export class SavedFilterDuplicateNameError extends Error {
  constructor(name: string) {
    super(`Saved filter name already in use: ${name}`);
    this.name = "SavedFilterDuplicateNameError";
  }
}

/** Marker error thrown when a record is not found or the caller does
 *  not own it. Mutate paths verify ownership and surface a single
 *  not-found shape rather than leaking the existence check. */
export class SavedFilterNotFoundError extends Error {
  constructor() {
    super("Saved filter not found");
    this.name = "SavedFilterNotFoundError";
  }
}

/**
 * Marker error thrown when the inbound {@link Filter} payload fails
 * the runtime shape check — the outer mode/input shape is not
 * recoverable. Server actions translate this into the same
 * `server-error` code used for unexpected DB failures because the
 * client UI cannot send a malformed filter through normal flows;
 * only a crafted authenticated request reaches this branch.
 */
export class SavedFilterInvalidError extends Error {
  constructor() {
    super("Saved filter payload failed runtime shape validation");
    this.name = "SavedFilterInvalidError";
  }
}

const PG_UNIQUE_VIOLATION = "23505";

interface SavedFilterRow {
  id: string;
  name: string;
  mode: string;
  filter_json: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

function rowToSavedFilter(row: SavedFilterRow): SavedFilter | null {
  const filter = filterFromStoredPayload(row.mode, row.filter_json);
  if (!filter) return null;
  return {
    id: row.id,
    name: row.name,
    filter,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Reassemble a stored row's `mode` + `filter_json` back into the
 * typed {@link Filter}. Unknown modes return `null` so list paths
 * can drop the row without throwing — a future read of a row written
 * by a newer server release stays safe rather than crashing the rail.
 *
 * Reviewer Round 3 (saved-filter shape validation): the structured
 * branch routes `filter_json` through {@link coerceEventListFilterInput}
 * so a row with a malformed field (e.g. `keywords: "not-an-array"`
 * planted by a crafted client before the write-side coerce was in
 * place, or a payload corrupted out-of-band) cannot crash the chip
 * bar / drawer when the rail loads it. Bad fields are dropped; the
 * surviving filter is still valid.
 */
function filterFromStoredPayload(
  mode: string,
  payload: unknown,
): Filter | null {
  if (mode === "structured") {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    return {
      mode: "structured",
      input: coerceEventListFilterInput(payload),
    };
  }
  if (mode === "query") {
    if (!payload || typeof payload !== "object") return null;
    const text = (payload as { text?: unknown }).text;
    if (typeof text !== "string") return null;
    return { mode: "query", text };
  }
  return null;
}

/**
 * Encode a {@link Filter} into the row's `(mode, filter_json)` columns.
 * v1 callers always pass `mode: "structured"`; the `mode: "query"`
 * branch is exercised by the codepath today as a forward-compat
 * test surface even though no UI emits it.
 *
 * Reviewer Round 3 (saved-filter shape validation): the structured
 * branch routes the inbound filter through {@link coerceFilter} so a
 * crafted client cannot persist a malformed `EventListFilterInput`
 * (e.g. `{ keywords: "not-an-array" }`) that would later crash the
 * chip / draft helpers. Throws {@link SavedFilterInvalidError} when
 * the outer shape is unrecoverable.
 */
function storedPayloadFromFilter(filter: Filter): {
  mode: string;
  json: string;
} {
  const coerced = coerceFilter(filter);
  if (!coerced) {
    throw new SavedFilterInvalidError();
  }
  if (coerced.mode === "structured") {
    return { mode: "structured", json: JSON.stringify(coerced.input) };
  }
  return { mode: "query", json: JSON.stringify({ text: coerced.text }) };
}

export function normalizeSavedFilterName(raw: string): string {
  return raw.trim();
}

/** Validate the user-supplied name. Returns `null` on success, or a
 *  diagnostic code the action layer can map to a localized message. */
export function validateSavedFilterName(
  name: string,
): "empty" | "tooLong" | null {
  if (name.length === 0) return "empty";
  if (name.length > SAVED_FILTER_NAME_MAX) return "tooLong";
  return null;
}

/**
 * Returns the current account's saved filters, newest update first.
 *
 * v1 rail only surfaces `mode = 'structured'` rows. The `'query'`
 * branch is reserved for the future search-language phase; until the
 * load path can drive it, hiding the row keeps it out of the
 * activatable rail rather than letting a click error out. The
 * `saveFilter` action also rejects non-structured submissions, so
 * rows of other modes only exist if a future migration writes them.
 */
export async function listSavedFiltersForAccount(
  accountId: string,
): Promise<SavedFilter[]> {
  const result = await query<SavedFilterRow>(
    `SELECT id, name, mode, filter_json, created_at, updated_at
       FROM saved_filter
      WHERE owner_account_id = $1
        AND mode = 'structured'
   ORDER BY updated_at DESC, name ASC`,
    [accountId],
  );
  const out: SavedFilter[] = [];
  for (const row of result.rows) {
    const entry = rowToSavedFilter(row);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * Insert a saved filter for the supplied account. Throws
 * {@link SavedFilterDuplicateNameError} when the name collides with
 * an existing entry for the same account. The caller is expected to
 * have already trimmed / validated the name.
 */
export async function insertSavedFilter(args: {
  accountId: string;
  name: string;
  filter: Filter;
}): Promise<SavedFilter> {
  const { mode, json } = storedPayloadFromFilter(args.filter);
  if (Buffer.byteLength(json, "utf8") > SAVED_FILTER_JSON_MAX_BYTES) {
    throw new Error("Saved filter payload exceeds size limit");
  }
  try {
    const result = await query<SavedFilterRow>(
      `INSERT INTO saved_filter (owner_account_id, name, mode, filter_json)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING id, name, mode, filter_json, created_at, updated_at`,
      [args.accountId, args.name, mode, json],
    );
    const row = result.rows[0];
    const entry = rowToSavedFilter(row);
    if (!entry) {
      throw new Error("Inserted saved filter could not be deserialized");
    }
    return entry;
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      throw new SavedFilterDuplicateNameError(args.name);
    }
    throw err;
  }
}

/**
 * Rename a saved filter the supplied account owns. Throws
 * {@link SavedFilterNotFoundError} when the row does not exist or
 * belongs to another account, and
 * {@link SavedFilterDuplicateNameError} when the new name collides.
 */
export async function renameSavedFilter(args: {
  accountId: string;
  id: string;
  newName: string;
}): Promise<SavedFilter> {
  try {
    const result = await query<SavedFilterRow>(
      `UPDATE saved_filter
          SET name = $3, updated_at = NOW()
        WHERE id = $1 AND owner_account_id = $2
       RETURNING id, name, mode, filter_json, created_at, updated_at`,
      [args.id, args.accountId, args.newName],
    );
    if (result.rows.length === 0) {
      throw new SavedFilterNotFoundError();
    }
    const entry = rowToSavedFilter(result.rows[0]);
    if (!entry) {
      throw new Error("Renamed saved filter could not be deserialized");
    }
    return entry;
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      throw new SavedFilterDuplicateNameError(args.newName);
    }
    throw err;
  }
}

/** Delete a saved filter the supplied account owns. Throws
 *  {@link SavedFilterNotFoundError} when nothing was deleted so the
 *  caller can surface the same message used for unauthorized access. */
export async function deleteSavedFilter(args: {
  accountId: string;
  id: string;
}): Promise<void> {
  const result = await query(
    `DELETE FROM saved_filter
      WHERE id = $1 AND owner_account_id = $2`,
    [args.id, args.accountId],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new SavedFilterNotFoundError();
  }
}

function isPgUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}
