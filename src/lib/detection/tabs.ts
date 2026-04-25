/**
 * Multi-tab result model for the Detection page (Phase Detection-10).
 *
 * Every tab is a regular search tab — its own filter + result pair —
 * with an optional user-override name and the UI state the operator
 * last touched (drawer draft, analytics expansion, quick peek
 * selection, pagination). The shell holds a `TabSnapshot[]` plus an
 * `activeTabId`; the filter drawer and active chip bar always reflect
 * the active tab's filter.
 *
 * Persistence split (documented here so future contributors don't
 * conflate the two stores):
 *
 * - URL search params are the **shareable** surface. At minimum they
 *   carry the active tab's Filter (the existing pivot / free-form
 *   param shape) + pagination. A link recipient sees only the active
 *   tab.
 * - `sessionStorage` carries the **private** surface — any additional
 *   tabs beyond the active one and every per-tab UI toggle (drawer
 *   draft, analytics strip expansion, manual names, pagination). A
 *   recipient of a shared URL has empty sessionStorage on first load
 *   and therefore sees exactly the one tab encoded in the URL.
 * - Cached result rows are intentionally NOT persisted: sessionStorage
 *   is quota-bounded, and a reloaded inactive tab should re-query when
 *   activated rather than show stale events from a prior session. The
 *   shell flips `hasQueried` back to `false` on rehydrated inactive
 *   tabs so the pre-query empty state invites the operator to click
 *   Apply or Refresh.
 *
 * A tab's `filter` is the abstract `Filter` from Phase Detection-2 —
 * a discriminated union `{ mode: "structured"; input } | { mode:
 * "query"; text }` — NOT a raw `EventListFilterInput`. URL
 * serialization, saved-filter loads, and pivot activations all
 * round-trip through this shape so the persistence layer does not
 * have to be rewritten when search-language mode lands.
 */

import type { EndpointEntry } from "./endpoint-filter";
import type { Filter } from "./filter";
import type { DetectionFilterDraft } from "./filter-draft";
import { INITIAL_PAGINATION_STATE, type PaginationState } from "./pagination";
import type { PeriodKey } from "./period";
import type { Event as DetectionEvent, PageInfo } from "./types";
import type { PivotFilterParams } from "./url-filters";

/**
 * Upper bound on concurrent tabs. Matches the umbrella issue's
 * guidance; the `+` affordance is disabled with a tooltip once
 * the list reaches this length.
 */
export const MAX_TABS = 8;

/** URL query key that anchors the active tab id for shareable links. */
export const ACTIVE_TAB_URL_PARAM = "tab";

/**
 * Copy the current URL's `?tab=<id>` value into `search` when present.
 * Called by the shell's URL writes (Apply, chip removal, pagination)
 * so the multi-tab wrapper's active-tab anchor survives committed
 * query transitions — otherwise the shell's fresh URLSearchParams
 * would clobber the tab id the wrapper wrote on mount / tab switch,
 * and a reload would seed a brand-new bootstrap tab alongside any
 * session-stored tabs.
 *
 * No-op when running outside a browser (SSR / tests without DOM) or
 * when the URL carries no tab id — matching the standalone shell
 * use case where the wrapper is absent.
 */
export function preserveActiveTabParam(search: URLSearchParams): void {
  if (typeof window === "undefined") return;
  const current = new URLSearchParams(window.location.search).get(
    ACTIVE_TAB_URL_PARAM,
  );
  if (current) search.set(ACTIVE_TAB_URL_PARAM, current);
}

/**
 * Opaque stable identifier for a tab, used as a React key, as the
 * anchor in the shareable URL (`?tab=<id>`), and as the lookup key in
 * the per-tab request-id refs the shell uses to drop stale async
 * responses from tabs the operator has closed or switched away from.
 *
 * Ids are short random tokens rather than monotonic counters so a
 * shared link's `?tab=` value doesn't collide with a locally-generated
 * tab on the recipient's side.
 */
export type TabId = string;

/**
 * Result cache for a single tab. Empty caches (`hasQueried: false`)
 * are the pre-query empty state new `+` tabs sit in until the
 * operator clicks Apply.
 */
export interface ResultCache {
  events: DetectionEvent[];
  /** Parallel to `events`: `eventKeys[i]` is the REview cursor for `events[i]`. */
  eventKeys: string[];
  totalCount: string | null;
  pageInfo: PageInfo | null;
  resultError: string | null;
  lastUpdatedMs: number | null;
  /**
   * True once a committed query has been dispatched for this tab.
   * Newly-created `+` tabs are false until the first Apply. Rehydrated
   * tabs (from sessionStorage) also come back as false because the
   * cache is not persisted — the operator must explicitly re-run.
   */
  hasQueried: boolean;
  /**
   * Monotonic per-tab counter. Bumped on every committed query
   * transition (Apply, chip removal, Refresh). Composed into the
   * React row key so per-row state (MorePopover open flag, focus)
   * cannot carry across committed queries.
   */
  queryEpoch: number;
  /** True while a query is in flight for this tab. */
  loading: boolean;
  /** Go-to-page walk progress hint; null when no walk is in flight. */
  walking: { current: number; target: number } | null;
}

export const EMPTY_RESULT_CACHE: ResultCache = {
  events: [],
  eventKeys: [],
  totalCount: null,
  pageInfo: null,
  resultError: null,
  lastUpdatedMs: null,
  hasQueried: false,
  queryEpoch: 0,
  loading: false,
  walking: null,
};

export interface TabSnapshot {
  readonly id: TabId;
  /**
   * User-supplied name; null means "derive from the filter summary"
   * (see {@link autoTabName}). A non-null value may be an auto name
   * the operator accepted verbatim or a manual rename — the two are
   * distinguished by {@link manualName}.
   */
  readonly name: string | null;
  /**
   * True when the operator explicitly renamed this tab. Manual names
   * survive filter edits; the `Reset name` affordance flips this
   * back to false so the auto summary kicks in again.
   */
  readonly manualName: boolean;
  readonly filter: Filter;
  readonly period: PeriodKey | null;
  readonly endpoints: EndpointEntry[];
  readonly pivotOnly: PivotFilterParams;
  readonly pagination: PaginationState;
  /**
   * Drawer draft edits for this tab — preserved across tab switches
   * so reopening the drawer in this tab shows the same in-flight
   * edits the operator had last time.
   */
  readonly draft: DetectionFilterDraft | null;
  readonly analyticsOpen: boolean;
  /**
   * Currently-open Quick peek inspector event, or null when no peek
   * is open. Stored as the full event so a tab switch can restore
   * the peek without re-resolving the locator against the cached
   * result. On rehydration from sessionStorage the field is reset
   * to null (see `tabs-storage.ts`) because the result cache itself
   * is not persisted — the operator must re-open the peek after a
   * reloaded tab is re-queried.
   */
  readonly quickPeekEvent: DetectionEvent | null;
  readonly result: ResultCache;
}

/**
 * Generate a short, URL-safe tab id. Uses `crypto.randomUUID` when
 * available (browsers + Node 19+) and falls back to
 * timestamp+random in environments that lack it. Trimmed to 10 hex
 * chars so `?tab=<id>` stays terse in shared URLs; the collision
 * probability at 8 concurrent tabs is negligible.
 */
export function createTabId(): TabId {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.slice(
    0,
    10,
  );
}

/**
 * Produce a short user-facing tab name from a filter's chip summary.
 * The summariser emits chips in a deterministic order (period first,
 * then scalars, then arrays, then categoricals); joining the first
 * two values with a middle dot keeps the tab label readable at typical
 * UI widths while still disambiguating tabs that differ by level or
 * kind.
 *
 * Falls back to `fallback` when the summary is empty (the `+` tab
 * case — a default-window filter whose only chip is the period).
 */
export function autoTabName(
  chipValues: readonly string[],
  fallback: string,
): string {
  const nonEmpty = chipValues.map((v) => v.trim()).filter((v) => v.length > 0);
  if (nonEmpty.length === 0) return fallback;
  return nonEmpty.slice(0, 2).join(" · ");
}

export interface CloseTabResult {
  tabs: TabSnapshot[];
  activeTabId: TabId;
  /**
   * True when closing removed the final tab and we auto-seeded a new
   * default tab. The caller uses this to kick the default-filter
   * auto-run per the Detection-10 acceptance:
   * "Closing the last tab auto-creates a default tab."
   */
  autoCreated: boolean;
}

/**
 * Remove a tab and pick the next active id. When the closed tab is
 * active, the right-hand neighbour becomes active; when there is no
 * right-hand neighbour, the left-hand one does. Closing the final
 * tab yields a freshly-created default tab via the supplied factory.
 */
export function closeTab(
  prev: { tabs: readonly TabSnapshot[]; activeTabId: TabId },
  closedId: TabId,
  createDefault: () => TabSnapshot,
): CloseTabResult {
  const idx = prev.tabs.findIndex((t) => t.id === closedId);
  if (idx === -1) {
    return {
      tabs: [...prev.tabs],
      activeTabId: prev.activeTabId,
      autoCreated: false,
    };
  }
  const filtered = prev.tabs.filter((_, i) => i !== idx);
  if (filtered.length === 0) {
    const seed = createDefault();
    return { tabs: [seed], activeTabId: seed.id, autoCreated: true };
  }
  let nextActive = prev.activeTabId;
  if (closedId === prev.activeTabId) {
    const neighbourIdx = idx < filtered.length ? idx : filtered.length - 1;
    nextActive = filtered[neighbourIdx].id;
  }
  return { tabs: filtered, activeTabId: nextActive, autoCreated: false };
}

/**
 * Whether the `+` affordance should be enabled. The tab bar surfaces
 * a disabled-with-tooltip state when this returns false.
 */
export function canAddTab(tabs: readonly TabSnapshot[]): boolean {
  return tabs.length < MAX_TABS;
}

/**
 * Build a fresh snapshot wrapping the supplied filter. Used by the
 * `+` affordance and by {@link closeTab} when auto-creating a default
 * tab. `result` is intentionally empty: the caller decides whether
 * to auto-run (initial load) or leave pre-query (user-created `+`
 * tab).
 */
export function createTabSnapshot(args: {
  filter: Filter;
  period: PeriodKey | null;
  endpoints?: EndpointEntry[];
  pivotOnly?: PivotFilterParams;
  pagination?: PaginationState;
}): TabSnapshot {
  return {
    id: createTabId(),
    name: null,
    manualName: false,
    filter: args.filter,
    period: args.period,
    endpoints: args.endpoints ?? [],
    pivotOnly: args.pivotOnly ?? {},
    pagination: args.pagination ?? INITIAL_PAGINATION_STATE,
    draft: null,
    analyticsOpen: false,
    quickPeekEvent: null,
    result: EMPTY_RESULT_CACHE,
  };
}
