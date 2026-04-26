"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  deleteFilter,
  listSavedFilters,
  renameFilter,
  type SavedFilterDeleteResult,
  type SavedFilterErrorCode,
  type SavedFilterMutateResult,
  saveFilter,
} from "@/app/[locale]/(dashboard)/detection/saved-filter-actions";
import type { Filter } from "@/lib/detection";
import type { SavedFilter } from "@/lib/detection/saved-filters";

export type { SavedFilterErrorCode } from "@/app/[locale]/(dashboard)/detection/saved-filter-actions";

/**
 * Client-side cache + mutation surface for the current account's
 * personal saved filters. The hook fetches the list once on mount and
 * folds in `save` / `rename` / `delete` results locally so the rail
 * stays consistent without re-querying after every mutation.
 *
 * The hook is owned by {@link DetectionTabsShell} so a save in one tab
 * shows up in the rail of every other tab — the rail itself reads from
 * this single shared instance through props.
 */
export interface UseSavedFiltersResult {
  filters: readonly SavedFilter[];
  /** True until the initial fetch has resolved — ok or error. */
  loading: boolean;
  /** Network/server failure during the initial load. Mutations expose
   *  per-call error codes via their return values; this field is just
   *  for the rail's loading-vs-empty-vs-error tri-state. */
  loadError: boolean;
  refresh: () => Promise<void>;
  save: (
    name: string,
    filter: Filter,
  ) => Promise<
    | { ok: true; filter: SavedFilter }
    | { ok: false; code: SavedFilterErrorCode }
  >;
  rename: (
    id: string,
    name: string,
  ) => Promise<
    | { ok: true; filter: SavedFilter }
    | { ok: false; code: SavedFilterErrorCode }
  >;
  remove: (
    id: string,
  ) => Promise<{ ok: true } | { ok: false; code: SavedFilterErrorCode }>;
}

export function useSavedFilters(): UseSavedFiltersResult {
  const [filters, setFilters] = useState<readonly SavedFilter[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  // Guard against late-arriving fetches landing after a tab switch
  // unmounts the wrapper. The wrapper itself is mounted for the
  // lifetime of the page so this primarily catches the in-flight
  // refresh between mount and a page-level navigation.
  const aliveRef = useRef(true);
  useEffect(() => {
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    const result = await listSavedFilters();
    if (!aliveRef.current) return;
    if (result.ok) {
      setFilters(sortFilters(result.filters));
      setLoading(false);
    } else {
      setLoadError(true);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(async (name: string, filter: Filter) => {
    const result: SavedFilterMutateResult = await saveFilter(name, filter);
    if (result.ok && aliveRef.current) {
      setFilters((prev) => sortFilters([result.filter, ...prev]));
    }
    return result;
  }, []);

  const rename = useCallback(async (id: string, name: string) => {
    const result: SavedFilterMutateResult = await renameFilter(id, name);
    if (result.ok && aliveRef.current) {
      setFilters((prev) =>
        sortFilters(prev.map((f) => (f.id === id ? result.filter : f))),
      );
    }
    return result;
  }, []);

  const remove = useCallback(async (id: string) => {
    const result: SavedFilterDeleteResult = await deleteFilter(id);
    if (result.ok && aliveRef.current) {
      setFilters((prev) => prev.filter((f) => f.id !== id));
    }
    return result;
  }, []);

  return { filters, loading, loadError, refresh, save, rename, remove };
}

/** Sort newest-update first, with names breaking ties — matches the
 *  server-side ordering so a list-then-mutate flow stays stable. */
function sortFilters(filters: readonly SavedFilter[]): SavedFilter[] {
  return [...filters].sort((a, b) => {
    const updated = b.updatedAt.localeCompare(a.updatedAt);
    return updated !== 0 ? updated : a.name.localeCompare(b.name);
  });
}
