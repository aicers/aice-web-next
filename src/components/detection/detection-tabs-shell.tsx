"use client";

/**
 * Multi-tab wrapper around {@link DetectionShell} (Phase Detection-10).
 *
 * Tab switch contract — the shell itself is single-tab: it owns the
 * active tab's live state (filter, result, pagination, drawer draft,
 * quick peek, etc.) and fires `onStateChange` so the wrapper can
 * mirror the latest snapshot into its `TabSnapshot[]`. On tab switch
 * the wrapper:
 *
 *   1. Reads the shell's latest reported snapshot from
 *      `shellSnapshotRef` and parks it in the outgoing tab's slot.
 *   2. Advances `activeTabId` and lets React remount the shell (via
 *      `key={activeTabId}`) with the incoming tab's snapshot as its
 *      new initial props. The remount naturally cancels any in-flight
 *      query for the outgoing tab — React disposes the promise's
 *      setState closures by unmounting.
 *   3. Rewrites the URL so the active tab's filter is what a link
 *      recipient would see. Everything else rides in
 *      `sessionStorage` — see `src/lib/detection/tabs-storage.ts`.
 *
 * Resuming an in-flight query across tab switches (Reviewer Round 4
 * item 1): because the remount path cancels the prior shell's
 * dispatch, a tab switched away mid-Apply (or mid-Refresh / mid-
 * paginator click) would otherwise end up with an empty post-reset
 * cache even though the operator clicked Apply. To avoid silently
 * dropping the request, the wrapper threads the snapshot's
 * `result.loading: true` flag through `initialResult.loading`; the
 * newly-mounted shell's `shouldResumeQueryOnMount` effect then
 * re-issues the same query at the snapshot's pagination. The tab's
 * cache receives the fresh rows on the rerun instead of on the
 * abandoned response.
 *
 * `+` creates a tab populated with the default filter but no
 * auto-run; the freshly-mounted shell's `hasQueried` starts false
 * because the empty result cache carries `totalCount: null`, so the
 * result region renders the pre-query empty panel until the operator
 * clicks Apply.
 */

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  DetectionShell,
  type DetectionShellInitialResult,
  type DetectionShellLabels,
  type DetectionShellStateSnapshot,
} from "@/components/detection/detection-shell";
import type { FilterDrawerOptions } from "@/components/detection/filter-drawer";
import {
  TabBar,
  type TabBarLabels,
  type TabBarTab,
} from "@/components/detection/tab-bar";
import type { EndpointEntry } from "@/lib/detection/endpoint-filter";
import type { Filter } from "@/lib/detection/filter";
import {
  type FilterChip,
  type SummarizeFilterLabels,
  summarizeFilter,
} from "@/lib/detection/filter-summary";
import {
  buildSearchParamsForFilter,
  type EncodedTabFilter,
  type PivotExtras,
} from "@/lib/detection/filter-url";
import {
  DEFAULT_PAGE_SIZE,
  type PaginationState,
  paginationToSearchEntries,
} from "@/lib/detection/pagination";
import {
  computePeriodRange,
  DEFAULT_PERIOD_KEY,
  type PeriodKey,
} from "@/lib/detection/period";
import { QUICK_PEEK_EVENT_PARAM } from "@/lib/detection/quick-peek-url";
import {
  ACTIVE_TAB_URL_PARAM,
  autoTabName,
  canAddTab as canAddTabFn,
  closeTab as closeTabFn,
  createTabSnapshot,
  MAX_TABS,
  type TabId,
  type TabSnapshot,
} from "@/lib/detection/tabs";
import {
  readTabsFromSession,
  writeTabsToSession,
} from "@/lib/detection/tabs-storage";
import type { PivotFilterParams } from "@/lib/detection/url-filters";
import { encodeEventLocator } from "@/lib/events/event-locator";

export interface DetectionTabsShellLabels {
  /** Inherits every Shell label — the wrapper forwards them unchanged. */
  shell: DetectionShellLabels;
  tabs: TabBarLabels;
  /** Fallback label when a filter's summary produces no chips. */
  tabFallbackName: string;
}

export interface DetectionTabsShellProps {
  title: string;
  labels: DetectionTabsShellLabels;
  options: FilterDrawerOptions;
  /** Bootstrap tab built from the URL-parsed active filter + SSR'd result. */
  initialTab: {
    id: TabId;
    filter: Filter;
    period: PeriodKey | null;
    pivotOnly: PivotFilterParams;
    /**
     * Rich endpoint entries restored from the encoded `?f=` URL blob.
     * The Investigation pivot fallback path always passes `[]`; only
     * the encoded-blob path can rebuild the typed entry list. The
     * shell uses these to populate the Network/IP advanced panel and
     * the endpoint chip bar on first render.
     */
    endpoints?: EndpointEntry[];
    pagination: PaginationState;
    result: DetectionShellInitialResult;
  };
}

/**
 * Public entry point. Seeds the tab list from SSR (one bootstrap
 * tab) and merges any additional tabs from sessionStorage on mount.
 */
export function DetectionTabsShell({
  title,
  labels,
  options,
  initialTab,
}: DetectionTabsShellProps) {
  const pathname = usePathname();

  // Seed the tab list with the SSR bootstrap tab. The in-effect merge
  // below folds in any additional tabs that were alive in the prior
  // sessionStorage payload (their result caches are wiped — see the
  // module comment in `tabs-storage.ts`).
  const [tabs, setTabs] = useState<TabSnapshot[]>(() => [
    bootstrapTabToSnapshot(initialTab),
  ]);
  const [activeTabId, setActiveTabId] = useState<TabId>(initialTab.id);

  const activeTab = useMemo<TabSnapshot>(() => {
    return tabs.find((t) => t.id === activeTabId) ?? tabs[0];
  }, [tabs, activeTabId]);

  // Latest snapshot reported by the (currently mounted) shell. Written
  // in an effect so it always trails one render behind live state; the
  // one-render lag is fine because tab-switch events come from user
  // gestures that always follow a rendered commit.
  const shellSnapshotRef = useRef<DetectionShellStateSnapshot | null>(null);
  // Ref mirror of `activeTabId` so memoised helpers below can resolve
  // the current active tab without becoming stale after a setState
  // batched with other tab updates.
  const activeTabIdRef = useRef<TabId>(activeTabId);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);
  // Reviewer Round 1 (item 4): ref mirror of `tabs` so close-tab can
  // compute the new active id from current state synchronously,
  // outside any state-updater closure. Without this mirror the close
  // handler had to read the next active id from inside a `setTabs`
  // updater and then call `setActiveTabId(nextActive)` — but
  // `setActiveTabId` had already captured the *old* `nextActive`
  // value before the updater ever ran, so `activeTabId` could be
  // left pointing at the just-closed tab.
  const tabsRef = useRef<TabSnapshot[]>(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  // Reviewer Round 1 (item 2): mirror the shell's live state into the
  // React `tabs` slot, not just a ref. The ref alone meant the tab
  // bar's auto-derived label and loading dot stayed pinned to the
  // bootstrap snapshot until the next tab-list mutation, and
  // `writeTabsToSession` (effect on `[tabs, activeTabId]`) never fired
  // for a plain Apply / Refresh / query completion. Updating React
  // state here keeps both up to date as soon as the shell commits a
  // change.
  //
  // Reviewer Round 2 (item 1): the routing target is the captured
  // `activeTabId` from this render, NOT `activeTabIdRef.current`. The
  // wrapper keys DetectionShell by `activeTabId`, so a tab switch
  // remounts the shell and its mount-time snapshot effect fires
  // synchronously after commit. React's child-before-parent passive
  // effect ordering means the child's mount snapshot lands BEFORE
  // the parent's `useEffect(() => { activeTabIdRef.current = ... })`
  // updates the ref — so reading the ref here would see the OUTGOING
  // tab id and merge the incoming tab's snapshot into the outgoing
  // tab's slot. With activeTabId in the dep list the closure rebinds
  // on every switch and matches the keyed shell instance.
  const handleShellStateChange = useCallback(
    (snapshot: DetectionShellStateSnapshot) => {
      shellSnapshotRef.current = snapshot;
      setTabs((prev) => routeSnapshotToTab(prev, activeTabId, snapshot));
    },
    [activeTabId],
  );

  /**
   * Merge the shell's latest reported state into the `prev` tab list,
   * returning a new tab list with the active tab's slot refreshed.
   * Called by every tab-list mutation (switch / add / close / rename)
   * so we never discard the shell's in-flight edits.
   */
  const withActiveSnapshot = useCallback(
    (prev: readonly TabSnapshot[]): TabSnapshot[] => {
      const currentActiveId = activeTabIdRef.current;
      const live = shellSnapshotRef.current;
      return prev.map((t) => {
        if (t.id !== currentActiveId) return t;
        if (!live) return t;
        return {
          ...t,
          filter: live.filter,
          period: live.period,
          endpoints: live.endpoints,
          pivotOnly: live.pivotOnly,
          pagination: live.pagination,
          draft: live.draft,
          analyticsOpen: live.analyticsOpen,
          quickPeekEvent: live.quickPeekEvent,
          result: live.result,
        };
      });
    },
    [],
  );

  // Shared summariser labels — tab names use the chip `value` string
  // already, so the prefix fields (`period`, `direction`, etc.) can
  // be blank; the auto-name helper only consumes values.
  const summarizeLabels = useMemo<SummarizeFilterLabels>(
    () => ({
      sensor: labels.shell.drawer.sensor.label,
      sensorAggregate: labels.shell.summarize.sensorAggregate,
      period: "",
      periodOptions: labels.shell.drawer.periodOptions,
      formatRange: ({ start, end }) => `${start} – ${end}`,
      direction: labels.shell.directionChips.label,
      directionValues: labels.shell.directionChips.values,
      confidence: labels.shell.confidenceChipLabel,
      source: labels.shell.chipLabels.source,
      destination: labels.shell.chipLabels.destination,
      keywords: labels.shell.chipLabels.keywords,
      hostnames: labels.shell.chipLabels.hostnames,
      userIds: labels.shell.chipLabels.userIds,
      userNames: labels.shell.chipLabels.userNames,
      userDepartments: labels.shell.chipLabels.userDepartments,
      levels: labels.shell.drawer.fields.levels,
      countries: labels.shell.drawer.fields.countries,
      learningMethods: labels.shell.drawer.fields.learningMethods,
      categories: labels.shell.drawer.fields.categories,
      kinds: labels.shell.drawer.fields.kinds,
      categoricalAggregate: ({ label, count }) => `${label}: ${count}`,
    }),
    [labels.shell],
  );

  const deriveAutoName = useCallback(
    (tab: TabSnapshot): string => {
      const chips: FilterChip[] = summarizeFilter(tab.filter, summarizeLabels, {
        period: tab.period,
        sensorOptions: [],
        categoricalOptions: {
          levels: options.levels,
          countries: options.countries,
          learningMethods: options.learningMethods,
          categories: options.categories,
          kinds: options.kinds,
        },
      });
      return autoTabName(
        chips.map((c) => c.value),
        labels.tabFallbackName,
      );
    },
    [summarizeLabels, options, labels.tabFallbackName],
  );

  // Rehydrate additional tabs from sessionStorage on mount. URL is
  // the source of truth for the active tab, so the bootstrap tab
  // stays anchored; any session-stored tab with the same id is
  // collapsed into the bootstrap (its UX state merged in), and
  // every other stored tab is appended as dormant. `MAX_TABS` caps
  // the final list so a legacy payload with > 8 tabs still loads.
  // Runs once on mount; subsequent session writes flow through the
  // persistence effect below.
  useEffect(() => {
    const stored = readTabsFromSession();
    if (!stored) return;
    setTabs((prev) => {
      const bootstrap = prev[0];
      if (!bootstrap) return prev;
      const matchingActive = stored.tabs.find((t) => t.id === bootstrap.id);
      const others = stored.tabs.filter((t) => t.id !== bootstrap.id);
      const mergedBootstrap: TabSnapshot = matchingActive
        ? {
            ...bootstrap,
            name: matchingActive.name,
            manualName: matchingActive.manualName,
            draft: matchingActive.draft,
            analyticsOpen: matchingActive.analyticsOpen,
          }
        : bootstrap;
      return [mergedBootstrap, ...others].slice(0, MAX_TABS);
    });
  }, []);

  // Persist tab state to sessionStorage on every relevant change.
  // Captures the live active-tab snapshot so the active tab's draft
  // and analytics state are restored on reload. Result cache is NOT
  // persisted (see `tabs-storage.ts`).
  //
  // Snapshot routing on tab switch: `handleShellStateChange` itself
  // captures `activeTabId` directly so the in-snapshot merge writes
  // the incoming tab's slot, not whichever tab `activeTabIdRef`
  // happens to point at when child effects fire. This persistence
  // pass still uses `withActiveSnapshot`, which reads from
  // `activeTabIdRef` + `shellSnapshotRef`; both refs are advanced
  // before this effect runs because React commits the parent's ref
  // updates after the child's mount snapshot has already landed in
  // `shellSnapshotRef`, so the merged write sees the new tab's
  // state.
  useEffect(() => {
    const withLive = withActiveSnapshot(tabs);
    writeTabsToSession(withLive, activeTabId);
  }, [tabs, activeTabId, withActiveSnapshot]);

  const tabBarTabs = useMemo<TabBarTab[]>(() => {
    return tabs.map((t) => {
      const displayName = t.name !== null ? t.name : deriveAutoName(t);
      return {
        id: t.id,
        label: displayName,
        isAuto: !t.manualName,
        loading: t.result.loading,
      };
    });
  }, [tabs, deriveAutoName]);

  const handleActivate = useCallback(
    (nextId: TabId) => {
      if (nextId === activeTabIdRef.current) return;
      setTabs((prev) => {
        if (!prev.some((t) => t.id === nextId)) return prev;
        return withActiveSnapshot(prev);
      });
      setActiveTabId(nextId);
    },
    [withActiveSnapshot],
  );

  const handleAddTab = useCallback(() => {
    const fresh = buildDefaultTabSnapshot();
    setTabs((prev) => {
      if (prev.length >= MAX_TABS) return prev;
      const withLive = withActiveSnapshot(prev);
      return [...withLive, fresh];
    });
    setActiveTabId(fresh.id);
  }, [withActiveSnapshot]);

  const handleCloseTab = useCallback(
    (id: TabId) => {
      // Reviewer Round 1 (item 4): compute the close result against
      // the ref-mirrored `tabs` synchronously rather than inside a
      // `setTabs` updater. The previous shape relied on the updater
      // mutating a closure variable that `setActiveTabId` had
      // already received — `setActiveTabId(nextActive)` ran with the
      // old value because React schedules the updater to run later,
      // not immediately. Reading `tabsRef.current` lets both setters
      // start from the same already-decided result.
      const currentTabs = tabsRef.current;
      const currentActive = activeTabIdRef.current;
      const withLive = withActiveSnapshot(currentTabs);
      const result = closeTabFn(
        { tabs: withLive, activeTabId: currentActive },
        id,
        buildDefaultTabSnapshot,
      );
      setTabs(result.tabs);
      if (result.activeTabId !== currentActive) {
        setActiveTabId(result.activeTabId);
      }
    },
    [withActiveSnapshot],
  );

  const handleRename = useCallback(
    (id: TabId, next: string) => {
      setTabs((prev) => {
        const withLive = withActiveSnapshot(prev);
        return withLive.map((t) =>
          t.id === id ? { ...t, name: next, manualName: true } : t,
        );
      });
    },
    [withActiveSnapshot],
  );

  const handleResetName = useCallback(
    (id: TabId) => {
      setTabs((prev) => {
        const withLive = withActiveSnapshot(prev);
        return withLive.map((t) =>
          t.id === id ? { ...t, name: null, manualName: false } : t,
        );
      });
    },
    [withActiveSnapshot],
  );

  // On activeTabId transitions, rewrite the URL so a reload /
  // bookmark lands on the same active tab. The filter encoder is
  // the same one the shell uses on Apply; the shell still writes
  // the URL on its own Apply / chip removal / pagination paths, so
  // this effect only needs to handle the tab-switch case where the
  // new active tab's filter may differ from what the shell last
  // wrote.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return;
    const search = buildUrlSearchForTab(tab);
    search.set(ACTIVE_TAB_URL_PARAM, tab.id);
    const qs = search.toString();
    const hash = window.location.hash;
    const url = qs ? `${pathname}?${qs}${hash}` : `${pathname}${hash}`;
    window.history.replaceState(window.history.state, "", url);
  }, [activeTabId, tabs, pathname]);

  const canAdd = canAddTabFn(tabs);

  return (
    <div className="flex flex-col gap-3">
      <TabBar
        tabs={tabBarTabs}
        activeTabId={activeTabId}
        canAddTab={canAdd}
        labels={labels.tabs}
        onActivate={handleActivate}
        onAddTab={handleAddTab}
        onCloseTab={handleCloseTab}
        onRename={handleRename}
        onResetName={handleResetName}
      />
      <DetectionShell
        key={activeTabId}
        title={title}
        labels={labels.shell}
        options={options}
        initialFilter={activeTab.filter}
        initialPeriod={activeTab.period}
        initialPivotOnly={activeTab.pivotOnly}
        initialPagination={activeTab.pagination}
        initialResult={{
          totalCount: activeTab.result.totalCount,
          error: activeTab.result.resultError,
          events: activeTab.result.events,
          eventKeys: activeTab.result.eventKeys,
          pageInfo: activeTab.result.pageInfo,
          // Reviewer Round 1 (item 3): thread the cached freshness
          // metadata through so a switched-back-to tab does not
          // silently re-stamp `Updated just now` or rewind the
          // queryEpoch / hasQueried flags.
          lastUpdatedMs: activeTab.result.lastUpdatedMs,
          hasQueried: activeTab.result.hasQueried,
          queryEpoch: activeTab.result.queryEpoch,
          // Reviewer Round 4 (item 1): thread `loading` back so a tab
          // remounted mid-Apply / mid-Refresh / mid-paginator click
          // resumes the query instead of dropping it on the floor.
          // The keyed remount naturally cancelled the prior shell's
          // in-flight request (React discarded its setState closures),
          // but the tab's cache never received the fresh rows. The
          // new shell's `shouldResumeQueryOnMount` effect re-issues
          // the same query at the snapshot's pagination. `walking` is
          // intentionally not threaded — Go-to-page walk progress
          // resets on remount and the operator can re-trigger a walk
          // if needed.
          loading: activeTab.result.loading,
        }}
        initialEndpoints={activeTab.endpoints}
        initialDraft={activeTab.draft}
        initialAnalyticsOpen={activeTab.analyticsOpen}
        initialQuickPeekEvent={activeTab.quickPeekEvent}
        onStateChange={handleShellStateChange}
      />
    </div>
  );
}

/**
 * Build a fresh tab snapshot with the default filter (`Last 1 hour`).
 * The result cache is the canonical empty cache, so the shell renders
 * the pre-query empty state until the operator clicks Apply. Used by
 * the `+` affordance and by `closeTab` when the operator closes the
 * last tab.
 */
export function buildDefaultTabSnapshot(): TabSnapshot {
  const range = computePeriodRange(DEFAULT_PERIOD_KEY);
  const filter: Filter = {
    mode: "structured",
    input: { start: range.start, end: range.end },
  };
  return createTabSnapshot({ filter, period: DEFAULT_PERIOD_KEY });
}

/**
 * Merge a fresh shell snapshot into an existing tab slot. Reviewer
 * Round 1 (item 2): used by `handleShellStateChange` to mirror live
 * state into the React `tabs` array (not just a ref) so the tab bar
 * label, loading dot, and session persistence all stay current.
 */
export function mergeSnapshot(
  tab: TabSnapshot,
  snapshot: DetectionShellStateSnapshot,
): TabSnapshot {
  return {
    ...tab,
    filter: snapshot.filter,
    period: snapshot.period,
    endpoints: snapshot.endpoints,
    pivotOnly: snapshot.pivotOnly,
    pagination: snapshot.pagination,
    draft: snapshot.draft,
    analyticsOpen: snapshot.analyticsOpen,
    quickPeekEvent: snapshot.quickPeekEvent,
    result: snapshot.result,
  };
}

/**
 * Route a snapshot to a specific tab slot. Reviewer Round 2 (item 1):
 * the wrapper invokes this from `handleShellStateChange` with
 * `targetTabId` captured from the render that mounted the keyed
 * `DetectionShell`, NOT from `activeTabIdRef.current`. The latter is
 * advanced in a parent passive effect that fires AFTER the child
 * shell's mount-time snapshot effect, so a routing decision based on
 * the ref would write the incoming tab's snapshot into the outgoing
 * tab's slot during a switch.
 */
export function routeSnapshotToTab(
  prev: readonly TabSnapshot[],
  targetTabId: TabId,
  snapshot: DetectionShellStateSnapshot,
): TabSnapshot[] {
  return prev.map((t) =>
    t.id === targetTabId ? mergeSnapshot(t, snapshot) : t,
  );
}

/** Seed a TabSnapshot from the server page's SSR'd bootstrap tab. */
export function bootstrapTabToSnapshot(
  initialTab: DetectionTabsShellProps["initialTab"],
): TabSnapshot {
  const hasQueried =
    initialTab.result.error === null && initialTab.result.totalCount !== null;
  return {
    id: initialTab.id,
    name: null,
    manualName: false,
    filter: initialTab.filter,
    period: initialTab.period,
    endpoints: initialTab.endpoints ?? [],
    pivotOnly: initialTab.pivotOnly,
    pagination: initialTab.pagination,
    draft: null,
    analyticsOpen: false,
    quickPeekEvent: null,
    result: {
      events: initialTab.result.events,
      eventKeys: initialTab.result.eventKeys,
      totalCount: initialTab.result.totalCount,
      pageInfo: initialTab.result.pageInfo,
      resultError: initialTab.result.error,
      lastUpdatedMs: hasQueried ? Date.now() : null,
      hasQueried,
      queryEpoch: 0,
      loading: false,
      walking: null,
    },
  };
}

/**
 * Compose the URL search params that describe the given tab's
 * committed filter + pagination. Reviewer Round 1 (item 1): the URL
 * encoder routes the full {@link Filter} (every
 * `EventListFilterInput` field plus the future `mode: "query"` shape)
 * through the `?f=` blob — the legacy pivot-param encoder only
 * covered a subset and silently dropped levels, countries, learning
 * methods, categories, directions, confidence bounds, sensors, and
 * endpoints from the URL.
 *
 * Reviewer Round 2 (item 2): re-emit the active tab's Quick peek
 * locator as `?event=` when present. The wrapper's URL effect runs
 * on every `tabs` change — including the snapshot mirror of the
 * shell's `quickPeekEvent` — and a full URL rewrite that omitted
 * the token would clobber the `?event=` param the shell wrote in
 * `writeQuickPeekToUrl`, breaking the share / refresh contract
 * documented in `src/lib/detection/quick-peek-url.ts`. The token is
 * scoped to the active tab, matching `tabs-storage.ts`'s split
 * (Quick peek selection rides on the URL, not in sessionStorage).
 */
export function buildUrlSearchForTab(tab: TabSnapshot): URLSearchParams {
  const encoded: EncodedTabFilter = {
    filter: tab.filter,
    period: tab.period,
    endpoints: tab.endpoints,
    pivotExtras: pivotExtrasFromTab(tab.pivotOnly),
  };
  const search = buildSearchParamsForFilter(encoded);
  if (tab.pagination.pageSize !== DEFAULT_PAGE_SIZE) {
    search.set("pageSize", String(tab.pagination.pageSize));
  }
  for (const [k, v] of paginationToSearchEntries(tab.pagination)) {
    if (k === "pageSize") continue;
    search.set(k, v);
  }
  if (tab.quickPeekEvent) {
    const token = encodeEventLocator(tab.quickPeekEvent);
    if (token) search.set(QUICK_PEEK_EVENT_PARAM, token);
  }
  return search;
}

/** Narrow the broader `PivotFilterParams` down to the URL-only extras
 *  the encoded blob carries — the rest of the pivot fields round-trip
 *  through the {@link Filter} payload itself. */
function pivotExtrasFromTab(pivot: PivotFilterParams): PivotExtras {
  const extras: PivotExtras = {};
  if (pivot.origPort !== undefined) extras.origPort = pivot.origPort;
  if (pivot.respPort !== undefined) extras.respPort = pivot.respPort;
  if (pivot.proto !== undefined) extras.proto = pivot.proto;
  return extras;
}
