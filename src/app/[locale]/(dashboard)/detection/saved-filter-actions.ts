"use server";

import { getCurrentSession } from "@/lib/auth/session";
import type { Filter } from "@/lib/detection";
import {
  deleteSavedFilter,
  insertSavedFilter,
  listSavedFiltersForAccount,
  normalizeSavedFilterName,
  renameSavedFilter,
  type SavedFilter,
  SavedFilterDuplicateNameError,
  SavedFilterNotFoundError,
  validateSavedFilterName,
} from "@/lib/detection/saved-filters";

/**
 * Discriminated client-callable error codes. Translates the typed
 * server-side errors into a serialization-friendly shape so the dialog
 * can render an inline message without leaking the underlying database
 * error details.
 */
export type SavedFilterErrorCode =
  | "unauthenticated"
  | "duplicate-name"
  | "invalid-name"
  | "unsupported-mode"
  | "not-found"
  | "server-error";

export type SavedFilterListResult =
  | { ok: true; filters: SavedFilter[] }
  | { ok: false; code: "unauthenticated" | "server-error" };

export type SavedFilterMutateResult =
  | { ok: true; filter: SavedFilter }
  | { ok: false; code: SavedFilterErrorCode };

export type SavedFilterDeleteResult =
  | { ok: true }
  | { ok: false; code: SavedFilterErrorCode };

export async function listSavedFilters(): Promise<SavedFilterListResult> {
  const session = await getCurrentSession();
  if (!session) return { ok: false, code: "unauthenticated" };
  try {
    const filters = await listSavedFiltersForAccount(session.accountId);
    return { ok: true, filters };
  } catch {
    return { ok: false, code: "server-error" };
  }
}

export async function saveFilter(
  name: string,
  filter: Filter,
): Promise<SavedFilterMutateResult> {
  const session = await getCurrentSession();
  if (!session) return { ok: false, code: "unauthenticated" };
  // v1 only persists `mode = 'structured'`; the `'query'` value is a
  // forward-compat seat reserved for the future search-language phase.
  // Reject any other mode at the action boundary so a crafted client
  // payload cannot land an unloadable row that the rail then has to
  // hide on read.
  if (filter.mode !== "structured") {
    return { ok: false, code: "unsupported-mode" };
  }
  const trimmed = normalizeSavedFilterName(name);
  if (validateSavedFilterName(trimmed) !== null) {
    return { ok: false, code: "invalid-name" };
  }
  try {
    const saved = await insertSavedFilter({
      accountId: session.accountId,
      name: trimmed,
      filter,
    });
    return { ok: true, filter: saved };
  } catch (err) {
    if (err instanceof SavedFilterDuplicateNameError) {
      return { ok: false, code: "duplicate-name" };
    }
    // SavedFilterInvalidError (the runtime shape coerce inside
    // `insertSavedFilter` rejected an unrecoverable outer shape) and
    // any unexpected DB failure both fall through to the generic
    // `server-error` code so the dialog renders its generic message.
    return { ok: false, code: "server-error" };
  }
}

export async function renameFilter(
  id: string,
  newName: string,
): Promise<SavedFilterMutateResult> {
  const session = await getCurrentSession();
  if (!session) return { ok: false, code: "unauthenticated" };
  const trimmed = normalizeSavedFilterName(newName);
  if (validateSavedFilterName(trimmed) !== null) {
    return { ok: false, code: "invalid-name" };
  }
  try {
    const saved = await renameSavedFilter({
      accountId: session.accountId,
      id,
      newName: trimmed,
    });
    return { ok: true, filter: saved };
  } catch (err) {
    if (err instanceof SavedFilterDuplicateNameError) {
      return { ok: false, code: "duplicate-name" };
    }
    if (err instanceof SavedFilterNotFoundError) {
      return { ok: false, code: "not-found" };
    }
    return { ok: false, code: "server-error" };
  }
}

export async function deleteFilter(
  id: string,
): Promise<SavedFilterDeleteResult> {
  const session = await getCurrentSession();
  if (!session) return { ok: false, code: "unauthenticated" };
  try {
    await deleteSavedFilter({ accountId: session.accountId, id });
    return { ok: true };
  } catch (err) {
    if (err instanceof SavedFilterNotFoundError) {
      return { ok: false, code: "not-found" };
    }
    return { ok: false, code: "server-error" };
  }
}
