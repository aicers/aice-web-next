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
  type FetchCustomersForFilterResult,
  fetchCustomersForFilter,
} from "@/app/[locale]/(dashboard)/detection/customer-actions";
import type { CustomerOption } from "@/components/detection/customer-multi-select";
import {
  type CustomerCache,
  DetectionShell,
  type DetectionShellInitialResult,
  type DetectionShellLabels,
  type DetectionShellStateSnapshot,
  derivePeriodForFilter,
} from "@/components/detection/detection-shell";
import type { FilterDrawerOptions } from "@/components/detection/filter-drawer";
import { PivotToast } from "@/components/detection/pivot-toast";
import {
  TabBar,
  type TabBarLabels,
  type TabBarTab,
} from "@/components/detection/tab-bar";
import { useSavedFilters } from "@/components/detection/use-saved-filters";
import {
  DEFAULT_ANALYTICS_DIMENSION,
  DEFAULT_ANALYTICS_TOP_N,
} from "@/lib/detection/analytics";
import {
  type EndpointEntry,
  endpointEntriesFromEndpointInputs,
} from "@/lib/detection/endpoint-filter";
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
import {
  openPivotTab,
  type PivotAction,
  type PivotPatch,
  type PivotTabSummary,
} from "@/lib/detection/pivot";
import { QUICK_PEEK_EVENT_PARAM } from "@/lib/detection/quick-peek-url";
import {
  buildRecommendedFilter,
  RECOMMENDED_PRESETS,
  type RecommendedPreset,
} from "@/lib/detection/recommended-filters";
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
  /**
   * Pivot feedback (Phase Detection-12). The wrapper renders the
   * transient toast that surfaces "Already filtered" /
   * "Tab cap reached" messages and the dismiss affordance label.
   *
   * The template strings carry ICU-style `{value}` / `{max}`
   * placeholders that the wrapper substitutes locally — strings cross
   * the server→client boundary cleanly, whereas closing over
   * `useTranslations` would serialize a function and trip Next.js's
   * "Functions cannot be passed directly to Client Components" guard.
   */
  pivot: {
    alreadyFilteredTemplate: string;
    tabCapReachedTemplate: string;
    dismissToast: string;
  };
}

export interface DetectionTabsShellProps {
  title: string;
  labels: DetectionTabsShellLabels;
  options: FilterDrawerOptions;
  /**
   * Customer scope resolved server-side from
   * `getEffectiveCustomerScope(session)`. Same helper that drives
   * the page-header customer indicator (#383), so the drawer's
   * Customer multi-select and the indicator can never disagree.
   *
   * Reviewer Round 1 #1 + #3: lifting the customer cache up to the
   * wrapper required a SSR seed so a freshly mounted page (including
   * any tab switch) can render customer chips with **names** on the
   * first paint, not raw IDs. The `kind` field mirrors the helper
   * discriminator so the drawer's empty-scope affordance fires
   * correctly when the SSR seed is `kind: 'empty'`.
   */
  initialCustomerScope: {
    kind: "admin" | "assigned" | "empty";
    customers: readonly { id: number; name: string }[];
  };
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
    /**
     * Reviewer Round 9: raw Quick peek URL token captured from the
     * server-parsed `?event=` param. The wrapper seeds the bootstrap
     * tab's `pendingQuickPeekToken` from this so the mount-time URL
     * effect re-emits the token rather than dropping it on the
     * floor. The shell's mount-restore reconciliation later resolves
     * it against the first slice (match → restore peek) or strips it
     * (proven stale). `null` when the URL carries no `?event=` param
     * or the token failed strict validation server-side.
     */
    quickPeekToken?: string | null;
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
  initialCustomerScope,
}: DetectionTabsShellProps) {
  const pathname = usePathname();

  // Customer cache lifted out of `DetectionShell`. The shell is
  // remounted on every tab switch (`key={activeTabId}`), so its own
  // state cannot satisfy the #384 page-session-shared cache contract
  // — opening the drawer in tab A and switching to tab B would drop
  // the cache and force another fetch. Owning the cache here keeps
  // it stable across tab create / switch / close as long as the
  // page itself is mounted, and lets every shell instance read the
  // same options (so chips in tab B benefit from a fetch in tab A
  // too).
  //
  // Reviewer Round 3 #1: the cache starts `idle`, not pre-seeded
  // `loaded`, so #384's explicit fetch contract holds — page entry
  // does not fetch, the first drawer open does, subsequent opens
  // reuse the cached result, and a scope change after page render
  // is picked up on that first-open fetch (not silently masked by a
  // stale SSR seed). The SSR scope still flows through as
  // `initialCustomerOptions`, but only as a *display fallback* for
  // the chip-name lookup so a bookmarked / saved-filter / pivot URL
  // still paints customer **names** on the first render rather than
  // raw IDs (Reviewer Round 1 #3). Once the first-open fetch
  // resolves, the live `loaded` cache supersedes the seed.
  const [customerCache, setCustomerCache] = useState<CustomerCache>(() => ({
    status: "idle",
  }));

  const initialCustomerOptions = useMemo<readonly CustomerOption[]>(
    () =>
      initialCustomerScope.customers.map((c) => ({
        id: c.id,
        name: c.name,
      })),
    [initialCustomerScope],
  );

  // Manual refresh callback exposed to the shell. Wraps
  // `fetchCustomersForFilter()` and writes the result back into the
  // wrapper-owned cache; pessimistic on error (cache reverts to
  // `error` state, the drawer surfaces a Retry).
  const triggerCustomerFetch = useCallback(() => {
    setCustomerCache({ status: "loading" });
    void fetchCustomersForFilter().then(
      (result: FetchCustomersForFilterResult) => {
        if (result.ok) {
          setCustomerCache({
            status: "loaded",
            kind: result.kind,
            options: result.customers.map((c) => ({
              id: c.id,
              name: c.name,
            })),
          });
        } else {
          setCustomerCache({ status: "error" });
        }
      },
      () => setCustomerCache({ status: "error" }),
    );
  }, []);

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
          analyticsDimension: live.analyticsDimension,
          analyticsTopN: live.analyticsTopN,
          quickPeekEvent: live.quickPeekEvent,
          pendingQuickPeekToken: live.pendingQuickPeekToken,
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
      customers: labels.shell.drawer.customer.label,
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
      // #384: customer aggregate speaks the issue's "{label}: {N} selected"
      // wording. The auto-name path consumes the chip `value`, so this
      // affects the auto-derived tab name when many customers are
      // selected too.
      customerAggregate: (count) =>
        `${labels.shell.drawer.customer.label}: ${labels.shell.summarize.customerAggregate.replace("{count}", String(count))}`,
    }),
    [labels.shell],
  );

  const customerSummaryOptions = useMemo<
    readonly { value: string; label: string }[]
  >(() => {
    const source =
      customerCache.status === "loaded"
        ? customerCache.options
        : initialCustomerOptions;
    return source.map((c) => ({ value: String(c.id), label: c.name }));
  }, [customerCache, initialCustomerOptions]);

  const deriveAutoName = useCallback(
    (tab: TabSnapshot): string => {
      const chips: FilterChip[] = summarizeFilter(tab.filter, summarizeLabels, {
        period: tab.period,
        sensorOptions: [],
        customerOptions: customerSummaryOptions,
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
    [summarizeLabels, options, labels.tabFallbackName, customerSummaryOptions],
  );

  // Rehydrate additional tabs from sessionStorage on mount. URL is
  // the source of truth for the active tab's filter and result, so
  // the bootstrap tab's filter / period / pagination / result win;
  // sessionStorage supplies the rest of the tab list and the
  // bootstrap's UX-only fields (name, manualName, draft,
  // analyticsOpen). `MAX_TABS` caps the final list so a legacy
  // payload with > 8 tabs still loads. Runs once on mount;
  // subsequent session writes flow through the persistence effect
  // below.
  //
  // Reviewer Round 6 (item 1): when the URL bootstrap id matches a
  // stored tab, replace that tab's slot in-place so the stored tab
  // order is preserved. The previous shape always returned
  // `[mergedBootstrap, ...others]`, which moved the active tab to
  // the front of the bar on every reload — breaking the "Reload
  // restores the tab set and active index" acceptance item and
  // changing neighbour-close semantics after each reload (closing
  // the active tab now activated whoever just got bumped to index
  // 1, not the original neighbour).
  useEffect(() => {
    const stored = readTabsFromSession();
    if (!stored) return;
    setTabs((prev) => mergeStoredTabsOnRehydrate(prev, stored.tabs));
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

  // Tab id that should briefly flash to acknowledge a pivot focus
  // gesture. The TabBar reads the value through the `flashTabId`
  // prop and auto-clears it after the animation resolves; the
  // wrapper resets it once the timeout fires so subsequent focus
  // gestures re-trigger the same animation.
  const [flashTabId, setFlashTabId] = useState<TabId | null>(null);
  useEffect(() => {
    if (!flashTabId) return;
    const handle = setTimeout(() => setFlashTabId(null), 1200);
    return () => clearTimeout(handle);
  }, [flashTabId]);

  const tabBarTabs = useMemo<TabBarTab[]>(() => {
    return tabs.map((t) => {
      const displayName = t.name !== null ? t.name : deriveAutoName(t);
      return {
        id: t.id,
        label: displayName,
        isAuto: !t.manualName,
        loading: t.result.loading,
        flash: t.id === flashTabId,
      };
    });
  }, [tabs, deriveAutoName, flashTabId]);

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

  // Personal saved filters are owned at the wrapper level so the
  // rail stays consistent across every tab and a save in one tab
  // shows up in another tab's rail. Each shell instance reads from
  // this single shared instance via props.
  const savedFiltersState = useSavedFilters();

  // Transient toast — surfaces `Already filtered` / `Tab cap reached`
  // for both the pivot path and saved-filter activation. Declared
  // above the saved-filter handler so the cap branch can dispatch
  // the same toast the pivot path uses.
  const [pivotToast, setPivotToast] = useState<string | null>(null);
  const dismissPivotToast = useCallback(() => setPivotToast(null), []);

  // Shared "load filter in new tab" core. Both the saved-filter and
  // recommended-preset paths funnel through this helper so the cap
  // toast, endpoint rehydration, and resume-on-mount seeding stay
  // identical. The two callers differ only in how they source the
  // tab's period metadata: saved filters re-derive it from the
  // filter's start / end (the persisted shape carries no period
  // field), while recommended presets pass `preset.period` straight
  // through — re-deriving it from freshly-built timestamps risks a
  // millisecond drift between the build clock and the
  // `matchesPeriodKey` clock that would silently null the period
  // chip.
  const loadFilterInNewTab = useCallback(
    (filter: Filter, period: PeriodKey | null) => {
      // Rehydrate `EndpointEntry[]` from `filter.input.endpoints` so
      // the new tab's chip bar / drawer match the saved Network/IP
      // rules. Stranding `endpoints: []` here makes the very next
      // drawer Apply rebuild the input from an empty draft and
      // silently drop the saved endpoints.
      const endpoints =
        filter.mode === "structured"
          ? endpointEntriesFromEndpointInputs(filter.input.endpoints)
          : [];
      const effect = resolveLoadSavedFilterEffect(filter, tabsRef.current, {
        tabCapReachedTemplate: labels.pivot.tabCapReachedTemplate,
        maxTabs: MAX_TABS,
        period,
        endpoints,
      });
      if (effect.kind === "toast") {
        setPivotToast(effect.message);
        return;
      }
      const seedWithLoad = effect.tab;
      setTabs((prev) => {
        if (prev.length >= MAX_TABS) return prev;
        const withLive = withActiveSnapshot(prev);
        return [...withLive, seedWithLoad];
      });
      setActiveTabId(seedWithLoad.id);
    },
    [labels.pivot.tabCapReachedTemplate, withActiveSnapshot],
  );

  const handleLoadSavedFilterInNewTab = useCallback(
    (filter: Filter) => {
      loadFilterInNewTab(filter, derivePeriodForFilter(filter));
    },
    [loadFilterInNewTab],
  );

  // Recommended-filter activation routes through the same load-in-new-
  // tab path Saved Filters use (Phase Detection-16). The preset is
  // resolved at activation time so the tab's start / end pair is
  // relative to "now" rather than frozen at page load — a preset
  // bound to `3y` opened at 9am today commits the same window the
  // period chip would compute. Read-only in v1: no current-tab
  // activation, no rename / delete affordances.
  //
  // Reviewer Round 1: thread `preset.period` directly into the tab
  // creation path instead of re-deriving from the freshly-built
  // start / end pair. `derivePeriodForFilter` would call
  // `matchesPeriodKey` with its own `new Date()`, and any
  // millisecond drift from the clock used inside
  // `buildRecommendedFilter` would null the period — leaving the
  // drawer / chip / tab summary unable to recognise a preset
  // described as "Time period = last N years".
  const handleLoadRecommendedFilterInNewTab = useCallback(
    (preset: RecommendedPreset) => {
      const filter = buildRecommendedFilter(preset);
      loadFilterInNewTab(filter, preset.period);
    },
    [loadFilterInNewTab],
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

  const handlePivot = useCallback(
    (patch: PivotPatch) => {
      const currentTabs = withActiveSnapshot(tabsRef.current);
      const activeId = activeTabIdRef.current;
      const active = currentTabs.find((t) => t.id === activeId);
      if (!active) return;
      const summaries: PivotTabSummary[] = currentTabs.map((t) => ({
        id: t.id,
        identity: { filter: t.filter, period: t.period },
      }));
      const action: PivotAction = openPivotTab({
        patch,
        active: {
          id: active.id,
          filter: active.filter,
          endpoints: active.endpoints,
          period: active.period,
        },
        tabs: summaries,
        maxTabs: MAX_TABS,
      });
      const effect = resolvePivotEffect(action, currentTabs, {
        alreadyFilteredTemplate: labels.pivot.alreadyFilteredTemplate,
        tabCapReachedTemplate: labels.pivot.tabCapReachedTemplate,
        maxTabs: MAX_TABS,
      });
      switch (effect.kind) {
        case "toast":
          setPivotToast(effect.message);
          return;
        case "focus":
          setTabs(effect.tabs);
          setActiveTabId(effect.activeTabId);
          setFlashTabId(effect.flashTabId);
          return;
        case "create":
          setTabs(effect.tabs);
          setActiveTabId(effect.activeTabId);
          return;
      }
    },
    [labels.pivot, withActiveSnapshot],
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
        onPivot={handlePivot}
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
        initialAnalyticsDimension={activeTab.analyticsDimension}
        initialAnalyticsTopN={activeTab.analyticsTopN}
        initialQuickPeekEvent={activeTab.quickPeekEvent}
        initialPendingQuickPeekToken={activeTab.pendingQuickPeekToken}
        onStateChange={handleShellStateChange}
        savedFilters={savedFiltersState}
        onLoadSavedFilterInNewTab={handleLoadSavedFilterInNewTab}
        recommendedPresets={RECOMMENDED_PRESETS}
        onLoadRecommendedFilterInNewTab={handleLoadRecommendedFilterInNewTab}
        customerCache={customerCache}
        onCustomerRefresh={triggerCustomerFetch}
        initialCustomerOptions={initialCustomerOptions}
      />
      <PivotToast
        message={pivotToast}
        onDismiss={dismissPivotToast}
        dismissLabel={labels.pivot.dismissToast}
      />
    </div>
  );
}

/**
 * Side-effect intent the React handler should apply when a pivot
 * action resolves. Pure / serializable so the toast / focus / create
 * branches can be unit-tested independently of React's state machinery
 * (Reviewer Round 1 follow-up: the wiring used to live inline in the
 * `handlePivot` callback, where the only way to exercise it was through
 * the `openPivotTab` helper's pure tests + a hope that the React
 * surface still wired the result correctly).
 */
export type PivotEffect =
  | { kind: "toast"; message: string }
  | {
      kind: "focus";
      tabs: TabSnapshot[];
      activeTabId: TabId;
      flashTabId: TabId;
    }
  | { kind: "create"; tabs: TabSnapshot[]; activeTabId: TabId };

export interface ResolvePivotEffectOptions {
  /** ICU-style template carrying a `{value}` placeholder. */
  alreadyFilteredTemplate: string;
  /** ICU-style template carrying a `{max}` placeholder. */
  tabCapReachedTemplate: string;
  maxTabs: number;
}

/**
 * Translate a {@link PivotAction} into the {@link PivotEffect} the
 * React handler applies. Pure: the only side effect is allocating
 * the seed tab on the `createTab` branch.
 */
export function resolvePivotEffect(
  action: PivotAction,
  currentTabs: readonly TabSnapshot[],
  opts: ResolvePivotEffectOptions,
): PivotEffect {
  switch (action.kind) {
    case "toastDuplicate":
      return {
        kind: "toast",
        message: opts.alreadyFilteredTemplate.replace(
          "{value}",
          action.displayValue,
        ),
      };
    case "focusTab":
      return {
        kind: "focus",
        tabs: [...currentTabs],
        activeTabId: action.tabId,
        flashTabId: action.tabId,
      };
    case "toastCapReached":
      return {
        kind: "toast",
        message: opts.tabCapReachedTemplate.replace(
          "{max}",
          String(opts.maxTabs),
        ),
      };
    case "createTab": {
      const seed = createTabSnapshot({
        filter: action.filter,
        period: action.period,
        endpoints: action.endpoints,
      });
      // Mark the seed as already-queried so the result list does
      // not show "Build a filter to begin"; the shell's Apply-on-
      // mount path is gated on `loading: true`, which we set so
      // the resume-on-mount effect dispatches the query for us.
      const seedWithLoad: TabSnapshot = {
        ...seed,
        result: { ...seed.result, hasQueried: true, loading: true },
      };
      return {
        kind: "create",
        tabs: [...currentTabs, seedWithLoad],
        activeTabId: seedWithLoad.id,
      };
    }
  }
}

/**
 * Pure decision helper for the "Load saved filter in new tab" path.
 * Mirrors the pivot path's `resolvePivotEffect` shape so the React
 * handler stays a thin dispatcher. At the cap returns a `toast`
 * effect carrying the same `tabCapReached` template the pivot path
 * uses; otherwise returns a `create` effect with the seeded tab
 * already pre-marked `hasQueried + loading` so the resume-on-mount
 * effect dispatches the query for us.
 *
 * Predefined endpoint references in `filter.input.endpoints` survive
 * intact through the (empty) endpoint mirror returned here — the
 * mirror only feeds the chip bar / drawer; the dispatched query
 * still uses `filter.input.endpoints` directly, and the next drawer
 * Apply replays predefined refs via `preservePredefinedEndpointInputs`
 * inside `buildAppliedFilter`.
 */
export type LoadSavedFilterEffect =
  | { kind: "toast"; message: string }
  | { kind: "create"; tab: TabSnapshot };

export interface ResolveLoadSavedFilterEffectOptions {
  /** ICU-style template carrying a `{max}` placeholder. */
  tabCapReachedTemplate: string;
  maxTabs: number;
  /** Period key derived from the saved filter. */
  period: PeriodKey | null;
  /** Rich endpoint mirror rehydrated from `filter.input.endpoints`. */
  endpoints: EndpointEntry[];
}

export function resolveLoadSavedFilterEffect(
  filter: Filter,
  currentTabs: readonly TabSnapshot[],
  opts: ResolveLoadSavedFilterEffectOptions,
): LoadSavedFilterEffect {
  if (currentTabs.length >= opts.maxTabs) {
    return {
      kind: "toast",
      message: opts.tabCapReachedTemplate.replace(
        "{max}",
        String(opts.maxTabs),
      ),
    };
  }
  const seed = createTabSnapshot({
    filter,
    period: opts.period,
    endpoints: opts.endpoints,
  });
  const seedWithLoad: TabSnapshot = {
    ...seed,
    result: { ...seed.result, hasQueried: true, loading: true },
  };
  return { kind: "create", tab: seedWithLoad };
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
    analyticsDimension: snapshot.analyticsDimension,
    analyticsTopN: snapshot.analyticsTopN,
    quickPeekEvent: snapshot.quickPeekEvent,
    pendingQuickPeekToken: snapshot.pendingQuickPeekToken,
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

/**
 * Merge the bootstrap tab (URL-authoritative filter / period /
 * pagination / result) with the previously stored tab list, used by
 * the mount-time rehydration effect. When the bootstrap id matches a
 * stored tab the slot is replaced in-place so the saved order is
 * preserved (Reviewer Round 6 item 1); otherwise the bootstrap is
 * prepended and stored tabs ride alongside as dormant siblings (a
 * shared link landing in a session that already has tabs).
 *
 * Pure helper so tests can pin the merge contract independently of
 * React's effect ordering.
 */
export function mergeStoredTabsOnRehydrate(
  bootstrapTabs: readonly TabSnapshot[],
  storedTabs: readonly TabSnapshot[],
): TabSnapshot[] {
  const bootstrap = bootstrapTabs[0];
  if (!bootstrap) return [...bootstrapTabs];
  const matchIndex = storedTabs.findIndex((t) => t.id === bootstrap.id);
  if (matchIndex >= 0) {
    const matched = storedTabs[matchIndex];
    const mergedBootstrap: TabSnapshot = {
      ...bootstrap,
      name: matched.name,
      manualName: matched.manualName,
      draft: matched.draft,
      analyticsOpen: matched.analyticsOpen,
      analyticsDimension: matched.analyticsDimension,
      analyticsTopN: matched.analyticsTopN,
    };
    const next = [...storedTabs];
    next[matchIndex] = mergedBootstrap;
    return next.slice(0, MAX_TABS);
  }
  return [bootstrap, ...storedTabs].slice(0, MAX_TABS);
}

/** Seed a TabSnapshot from the server page's SSR'd bootstrap tab. */
export function bootstrapTabToSnapshot(
  initialTab: DetectionTabsShellProps["initialTab"],
): TabSnapshot {
  // Reviewer Round 8 (item 1): the page entry always attempts the
  // first query — see `searchEventsAtAnchor` in
  // `src/app/[locale]/(dashboard)/detection/page.tsx`. Both the
  // success and the failure case count as "this tab has run a query",
  // so `hasQueried` is true on either branch. Keeping it tied to a
  // successful `totalCount` would strand a transient backend failure
  // on the bootstrap tab in the error panel: the Round 7 `!hasQueried`
  // guard on `handleRefresh` would short-circuit both the header
  // Refresh button and the error-state Retry button, leaving the
  // operator with visible retry controls that do nothing. The
  // `+`-affordance flow runs `buildDefaultTabSnapshot`, which keeps
  // `hasQueried: false` for the genuine "never queried" case the
  // Round 7 guard protects.
  const succeededFirstQuery =
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
    analyticsDimension: DEFAULT_ANALYTICS_DIMENSION,
    analyticsTopN: DEFAULT_ANALYTICS_TOP_N,
    quickPeekEvent: null,
    // Reviewer Round 9: seed the pending token from the server-parsed
    // URL param. The wrapper's `buildUrlSearchForTab` falls through to
    // this value when `quickPeekEvent` is null, so the mount-time URL
    // rewrite preserves `?event=<token>` until the shell's mount-
    // restore reconciliation decides restore vs. strip on a later
    // successful slice. Without this seed, an errored bootstrap
    // would have the wrapper clobber the URL token before Retry
    // could match it against the recovered slice.
    pendingQuickPeekToken: initialTab.quickPeekToken ?? null,
    result: {
      events: initialTab.result.events,
      eventKeys: initialTab.result.eventKeys,
      totalCount: initialTab.result.totalCount,
      pageInfo: initialTab.result.pageInfo,
      resultError: initialTab.result.error,
      lastUpdatedMs: succeededFirstQuery ? Date.now() : null,
      hasQueried: succeededFirstQuery || initialTab.result.error !== null,
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
 *
 * Reviewer Round 9: when `quickPeekEvent` is null but the tab still
 * carries a `pendingQuickPeekToken` (the SSR bootstrap captured a
 * URL `?event=` token that has not yet been resolved against a
 * successful slice), re-emit the raw pending token. This keeps the
 * wrapper's mount-time URL rewrite from clobbering the URL token
 * before the shell's later restore-vs-strip reconciliation runs on
 * a successful Retry / Refresh. Once the shell resolves the token
 * (matched event → setQuickPeekEvent + clear pending) or proves it
 * stale (URL stripped + clear pending), the snapshot's pending
 * field returns to null and this branch becomes a no-op.
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
  } else if (tab.pendingQuickPeekToken) {
    search.set(QUICK_PEEK_EVENT_PARAM, tab.pendingQuickPeekToken);
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
