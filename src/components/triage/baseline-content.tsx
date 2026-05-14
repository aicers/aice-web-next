"use client";

/**
 * Baseline-mode body of the Triage page. Phase 1.A — discussion #447
 * §6 deprecatable seam: this subtree must NOT import any policy
 * module so removing the mode toggle reduces the page to baseline-
 * only with a one-line edit.
 */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchStoryDetail,
  refreshTriageStories,
  submitSaveAnalystCuratedStory,
} from "@/app/[locale]/(dashboard)/triage/story-actions";
import type {
  ScoredTriageEvent,
  TriageAsset,
  TriageLoadResult,
  TriagePeriod,
} from "@/lib/triage";
import { appendRecentKeyword } from "@/lib/triage/keywords";
import {
  appendPivotStep,
  backtrackPivotTrail,
  buildPivotPanel,
  clearPivotTrail,
  getPivotDimension,
  hasPivotedAwayFromAsset,
  isStaticTier2Dimension,
  type PivotDimensionId,
  type PivotOrigin,
  type PivotStep,
  type PivotValue,
  pivotIndexFor,
  resolveStepFocusEvents,
} from "@/lib/triage/pivot";
import { baselineScore } from "@/lib/triage/scoring";
import { storyMembersToScoredEvents } from "@/lib/triage/story/pivot-adapter";
import type {
  TriageStory,
  TriageStoryMemberDetail,
} from "@/lib/triage/story/types";
import { tier2DedupeKey } from "@/lib/triage/tier2-cache";
import {
  isTier2ServerDimension,
  type Tier2Dimension,
} from "@/lib/triage/tier2-filter";
import {
  parseTriagePivotHash,
  parseTriageStoriesHash,
  pivotHashFromTrail,
  replaceTriagePivotHash,
  replaceTriageStoriesHash,
  type TriagePivotMode,
  type TriageStoryHashFocus,
} from "@/lib/triage/url-hash";
import {
  TIER2_PREFETCH_MODAL_THRESHOLD,
  useTier2Pivot,
} from "@/lib/triage/use-tier2-pivot";
import {
  type TriageAssetDetailLabels,
  TriageAssetDetailView,
} from "./asset-detail";
import { type TriageAssetListLabels, TriageAssetListView } from "./asset-list";
import { type TriageFunnelLabels, TriageFunnelView } from "./funnel";
import type { TriageMode } from "./mode-toggle";
import {
  TriagePivotBreadcrumb,
  type TriagePivotBreadcrumbLabels,
} from "./pivot/pivot-breadcrumb";
import {
  TriagePivotPanel,
  type TriagePivotPanelLabels,
} from "./pivot/related-events-panel";
import type { TriagePivotScope } from "./scope-toggle";
import {
  type TriageSaveAsStoryLabels,
  TriageSaveAsStoryModal,
} from "./story/save-as-story-modal";
import {
  TriageStoriesView,
  type TriageStoriesViewLabels,
} from "./story/stories-view";
import {
  type TriageTabId,
  TriageTabStrip,
  type TriageTabStripLabels,
  tabsForMode,
} from "./tab-strip";
import {
  Tier2ErrorNotice,
  type Tier2ErrorNoticeLabels,
} from "./tier2-error-notice";
import {
  Tier2EvictionNotice,
  type Tier2EvictionNoticeLabels,
} from "./tier2-eviction-notice";
import {
  Tier2PrefetchModal,
  type Tier2PrefetchModalLabels,
} from "./tier2-prefetch-modal";
import {
  Tier2ProgressNotice,
  type Tier2ProgressNoticeLabels,
} from "./tier2-progress-notice";

export interface TriageBaselineLabels {
  funnel: TriageFunnelLabels;
  assetList: TriageAssetListLabels;
  assetDetail: TriageAssetDetailLabels;
  pivotPanel: TriagePivotPanelLabels;
  pivotBreadcrumb: TriagePivotBreadcrumbLabels;
  tier2Modal: Tier2PrefetchModalLabels;
  tier2Eviction: Tier2EvictionNoticeLabels;
  tier2Error: Tier2ErrorNoticeLabels;
  tier2Progress: Tier2ProgressNoticeLabels;
  staleHashFallback: string;
  /**
   * Surfaced when the Tier 2 `sameSensor` pivot resolved a sensor name
   * to a `nodeId` that REview rejected with `Forbidden` because the
   * sensor is no longer in the caller's customer scope (#502 —
   * `scope-forbidden` arm). Distinct from {@link staleHashFallback},
   * which covers the URL-no-longer-matches-corpus case (and the
   * `name-unresolved` arm), so the operator can tell "no longer
   * accessible in your scope" apart from "this URL is stale".
   */
  sensorScopeForbiddenFallback: string;
  tabStrip: TriageTabStripLabels;
  stories: TriageStoriesViewLabels;
  saveAsStory: TriageSaveAsStoryLabels;
}

interface TriageBaselineContentProps {
  result: TriageLoadResult;
  /**
   * Bumps whenever the parent (TriageShell) changes the loaded
   * period or customer scope. The breadcrumb reset hook listens on
   * this so the parent can confirm-then-clear without reaching into
   * this component's state.
   */
  resetSignal: number;
  /**
   * The currently-loaded period — passed in (rather than derived from
   * event timestamps) so the Tier 2 cache key and fetch filter use
   * the operator's actual range, not the min/max of loaded events.
   */
  period: TriagePeriod;
  /** Stable identifier for the customer scope; gates Tier 2 cache reuse. */
  customerScope?: string;
  /** Triage scope (Tier 1 vs Tier 2) — controlled by the shell. */
  scope: TriagePivotScope;
  /**
   * Called once per mount with the scope decoded from the URL hash,
   * if any. Lets the shell adopt the shared URL's intended scope on
   * restore.
   */
  onScopeRestoredFromHash?: (scope: TriagePivotScope) => void;
  /**
   * Called whenever the breadcrumb gains or loses a dimension step.
   * The shell uses the latest value to decide whether a period
   * change should surface a confirmation modal — pivots are local
   * state, so a period change that wipes them needs explicit consent.
   */
  onPivotTrailChange?: (hasDimensionSteps: boolean) => void;
  /**
   * Current mode-toggle value. Stories tab is only rendered in
   * `"baseline"` (corpus A); `"policies"` mode hides the tab entirely
   * — see `tabsForMode` in `./tab-strip.tsx`.
   */
  mode: TriageMode;
  /** Server-loaded Stories slice for the current period. */
  stories?: ReadonlyArray<TriageStory>;
  /** True when any per-tenant Stories page hit the cap. */
  storiesTruncated?: boolean;
  labels: TriageBaselineLabels;
}

/** Detail-panel events shown for a pivot focus. */
const PIVOT_FOCUS_DETAIL_EVENT_CAP = 50;

function scopeToHashMode(scope: TriagePivotScope): TriagePivotMode {
  return scope === "tier2" ? "tier2" : "tier1";
}

export function TriageBaselineContent({
  result,
  resetSignal,
  period,
  customerScope = "default",
  scope,
  onScopeRestoredFromHash,
  onPivotTrailChange,
  mode,
  stories = [],
  storiesTruncated = false,
  labels,
}: TriageBaselineContentProps) {
  const router = useRouter();
  const tier2 = useTier2Pivot({
    periodStartIso: period.startIso,
    periodEndIso: period.endIso,
    customerScope,
    enabled: scope === "tier2",
    tier1Corpus: result.events,
  });
  const initialAsset = result.assets[0] ?? null;
  const initialFocus = initialAsset
    ? { customerId: initialAsset.customerId, address: initialAsset.address }
    : null;
  const [selected, setSelected] = useState<{
    customerId: number;
    address: string;
  } | null>(initialFocus);
  const [trail, setTrail] = useState<PivotStep[]>(() =>
    initialFocus
      ? [
          {
            kind: "asset",
            customerId: initialFocus.customerId,
            address: initialFocus.address,
          },
        ]
      : [],
  );
  // Page-session-only recent `keywords` submissions (#499). Bounded
  // at 5 entries via {@link appendRecentKeyword}; cleared whenever the
  // period / customer scope rotates (same trigger as the Tier 2 cache).
  // The list is intentionally not persisted to URL hash or localStorage
  // so a stale typed value cannot be revived without the operator
  // re-typing it.
  const [recentKeywords, setRecentKeywords] = useState<readonly string[]>([]);
  // Active peer view inside Baseline mode (#490). Defaults to
  // `asset-list`; URL hash restore happens client-side in an effect
  // below. The Stories tab is hidden in `policies` mode — the tab
  // strip itself omits the entry, so flipping mode while on Stories
  // coerces the selection back to `asset-list` via the effect.
  const [tab, setTab] = useState<TriageTabId>("asset-list");
  const [focusedStory, setFocusedStory] = useState<TriageStory | null>(null);
  // Pivot-origin marker (#553). `"asset"` is the default Phase 1
  // shape; `"story"` is set when the analyst drills into the Pivot
  // peer view from a Story member row (or restores the same state
  // from a `triage.pivot.story=...` URL hash). When set, the trail
  // carries dimension steps only — no asset crumb — and the pivot
  // panel reads `storyMemberEvents` as its corpus instead of
  // `result.events`. See PR description for the rationale.
  const [pivotOrigin, setPivotOrigin] = useState<PivotOrigin>({
    kind: "asset",
  });
  // The Story's member events normalized into the pivot index's
  // input shape. Populated when {@link pivotOrigin} flips to
  // `"story"` — either through a `Pivot-from-Story` click (the
  // stories-view callback hands the full member-detail list down)
  // or after a hash-restore call to {@link fetchStoryDetail}.
  // Cleared whenever the origin returns to `"asset"`.
  const [storyMemberEvents, setStoryMemberEvents] = useState<
    readonly ScoredTriageEvent[]
  >([]);
  // When the post-save flow seeds `focusedStory` with a synthetic
  // placeholder, the placeholder is by construction absent from the
  // current `stories` prop until `router.refresh()` returns the new
  // slice. The reconciliation effect below clears focus on a list/
  // period rotation that does not contain the focused Story; this
  // ref holds the `stories` reference at placeholder-creation time so
  // that initial reconciliation pass (still on the pre-refresh prop)
  // is skipped. The ref is consumed (set back to `null`) on the first
  // rotation past that reference — if the real row still is not in
  // the new prop slice, focus is cleared like any other stale focus.
  const placeholderRotationGateRef = useRef<ReadonlyArray<TriageStory> | null>(
    null,
  );
  const [showStaleStoryHash, setShowStaleStoryHash] = useState<boolean>(false);
  // Pivot focus events used to seed the "Save as Story" modal.
  const [saveAsStoryOpen, setSaveAsStoryOpen] = useState<boolean>(false);
  // Success toast for the curated-Story save flow. Reset whenever
  // the analyst dismisses the toast, switches tabs away from
  // Stories, or after a short timeout — the toast is purely
  // confirmational, not a persistent status banner.
  const [savedToastVisible, setSavedToastVisible] = useState<boolean>(false);

  const selectedAsset = useMemo(() => {
    if (!selected) return null;
    return (
      result.assets.find(
        (a) =>
          a.customerId === selected.customerId &&
          a.address === selected.address,
      ) ?? null
    );
  }, [result.assets, selected]);

  const effectiveSelection =
    selectedAsset === null && initialFocus !== null ? initialFocus : selected;
  const effectiveAsset = selectedAsset ?? initialAsset;

  // When the loaded result rotates (period change → new corpus), the
  // breadcrumb must reset to the new asset root. The parent already
  // confirms with the operator before triggering the period change,
  // so this effect just applies the cleared state. `resetSignal` is
  // listed as a dep because a confirm-then-reload may keep the same
  // initialAddress (when the new period happens to surface the same
  // top asset) yet still need to clear the trail.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetSignal is the trigger
  useEffect(() => {
    setSelected(initialFocus);
    // Period / customer-scope rotation also retires any Story-origin
    // pivot trail (#553) — the Story's member corpus is period-
    // independent at the SQL layer, but the menu's read-time
    // `baseline_score` cohort depends on the loaded period so the
    // adapted ScoredTriageEvent list goes stale on rotation.
    setPivotOrigin({ kind: "asset" });
    setStoryMemberEvents([]);
    setTrail(
      initialFocus
        ? [
            {
              kind: "asset",
              customerId: initialFocus.customerId,
              address: initialFocus.address,
            },
          ]
        : [],
    );
    // Recent `keywords` chips are page-session-only and share the
    // Tier 2 cache's rotate trigger (period / customer scope change).
    // Without this clear the operator could see chips that no longer
    // make sense against the freshly-loaded corpus.
    setRecentKeywords([]);
    // The fallback notice describes the prior trail; once the corpus
    // rotates it is no longer accurate and would otherwise persist
    // across the reset.
    setFallbackNotice(null);
    // The corpus has rotated — any pending hash-restore work was
    // queued against the prior corpus and would no longer make sense
    // against the freshly loaded events. Clear it so a queued ancestor
    // fetch does not fire under the wrong period / customer scope and
    // so the deferred validator does not run against the new asset.
    pendingHashFetchesRef.current = [];
    pendingValidationsRef.current = [];
    draining.current = null;
    // Story-origin hash restore (#553) is async; on a period / customer
    // scope rotation any in-flight `fetchStoryDetail` is keyed on the
    // old period so its resolve branches must not run against the new
    // corpus.
    storyRestoreTokenRef.current += 1;
    // `customerScope` is named here because the Tier 2 cache reset in
    // `useTier2Pivot` rotates on it too; without it a scope switch that
    // happens to land on the same top asset would clear the cache but
    // leave stale keyword chips visible, potentially re-firing a search
    // from the prior scope into the new one (#499).
  }, [
    initialFocus?.customerId,
    initialFocus?.address,
    customerScope,
    resetSignal,
  ]);

  useEffect(() => {
    onPivotTrailChange?.(hasPivotedAwayFromAsset(trail));
  }, [trail, onPivotTrailChange]);

  // Auto-dismiss the "Story saved" toast a few seconds after it
  // surfaces. The toast itself is also clickable (routes the
  // analyst to the Stories tab) so a longer timeout would feel
  // stale once the operator has acted; 6 seconds matches the rest
  // of the Triage menu's transient banners.
  useEffect(() => {
    if (!savedToastVisible) return;
    const handle = window.setTimeout(() => setSavedToastVisible(false), 6000);
    return () => window.clearTimeout(handle);
  }, [savedToastVisible]);

  // Restore the Stories tab + focused-story URL hash on mount (client-
  // only — Server Components cannot read `location.hash`). A bare
  // `triage.story=<id>` (no `customerId/` prefix) flips the stale-hash
  // toast in the Stories view. A `triage.story=...` value with an id
  // that does not match any loaded Story silently degrades to the
  // Stories list root, same as the asset hash treatment in #518.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only
  useEffect(() => {
    if (typeof window === "undefined") return;
    const parsed = parseTriageStoriesHash(window.location.hash);
    if (parsed.tab !== null) setTab(parsed.tab);
    if (parsed.storyStaleHash) setShowStaleStoryHash(true);
    if (parsed.story && parsed.story.customerId !== null) {
      const focus = parsed.story as TriageStoryHashFocus & {
        customerId: number;
      };
      const found = stories.find(
        (s) => s.customerId === focus.customerId && s.storyId === focus.storyId,
      );
      if (found) {
        setFocusedStory(found);
      } else {
        setShowStaleStoryHash(true);
      }
    }
  }, []);

  // Mode-toggle effect: hide the Stories tab when the mode flips to
  // `policies` so a user who lands on Stories then switches modes
  // does not stare at a hidden tab's content.
  useEffect(() => {
    const allowed = tabsForMode(mode);
    if (!allowed.includes(tab)) {
      setTab("asset-list");
    }
  }, [mode, tab]);

  // Reconcile the focused Story against the freshly-loaded list. Two
  // jobs:
  //   1. Post-save flow seeds `focusedStory` with a synthetic
  //      placeholder; when the real row arrives in `stories`, promote
  //      it so the detail panel renders the authoritative
  //      `summary_payload` / top members instead of the empty
  //      synthetic.
  //   2. List/period rotation can drop the focused Story (a period
  //      change to a window the Story no longer overlaps, a mode
  //      flip, a filter change). Without reconciliation the tab keeps
  //      rendering the old detail panel and the hash sync keeps
  //      serializing its `(customerId, storyId)`, so the visible
  //      state disagrees with the period-scoped list contract. Clear
  //      focus when no match exists.
  //
  // The placeholder case is special: the synthetic row is absent from
  // `stories` by construction until `router.refresh()` returns the new
  // slice, and reconciling immediately would clear the freshly-set
  // focus. `placeholderRotationGateRef` holds the `stories` reference
  // at placeholder-creation time; we skip the clear path while we are
  // still seeing that same reference, and consume the gate on the
  // first rotation past it.
  useEffect(() => {
    if (focusedStory === null) return;
    const real = stories.find(
      (s) =>
        s.customerId === focusedStory.customerId &&
        s.storyId === focusedStory.storyId,
    );
    if (real) {
      if (real !== focusedStory) setFocusedStory(real);
      placeholderRotationGateRef.current = null;
      return;
    }
    if (placeholderRotationGateRef.current === stories) {
      // Still on the pre-refresh prop the placeholder was created
      // against. Hold focus and wait for the next rotation.
      return;
    }
    placeholderRotationGateRef.current = null;
    setFocusedStory(null);
  }, [stories, focusedStory]);

  // URL hash sync for Stories tab + focused story. Foreign keys
  // (`triage.pivot.*`, `triage.strictness.*`) are preserved.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const tabValue = tab === "asset-list" ? null : tab;
    const focus =
      focusedStory === null
        ? null
        : {
            customerId: focusedStory.customerId,
            storyId: focusedStory.storyId,
          };
    const next = replaceTriageStoriesHash(window.location.hash, {
      tab: tabValue,
      story: focus,
      storyStaleHash: false,
    });
    const target = next.length > 0 ? `#${next}` : "";
    if (target === window.location.hash) return;
    const url = `${window.location.pathname}${window.location.search}${target}`;
    window.history.replaceState(null, "", url);
  }, [tab, focusedStory]);

  const activeStep = trail.length > 0 ? trail[trail.length - 1] : null;

  // In Tier 2 mode, splice every cached Tier 2 fetch result that
  // appears anywhere on the trail into the corpus. Restricting the
  // splice to the active step would lose Tier 2 events as soon as
  // the operator pivots from a server-filtered dimension into a
  // client-intersection one (#453 says client-intersection pivots
  // should compute against the corpus *and* prior Tier 2 fetch
  // results). The dedupe set keeps a single event from being
  // counted twice when several trail steps share rows.
  const expandedTier2Events: ScoredTriageEvent[] = useMemo(() => {
    if (scope !== "tier2") return [];
    const corpusKeys = new Set<string>();
    for (const ev of result.events) corpusKeys.add(tier2DedupeKey(ev));
    const seen = new Set<string>();
    const out: ScoredTriageEvent[] = [];
    // The asset crumb's `customerId` keys the Tier 2 cache lookup
    // (#502 — without it, two tenants pivoting the same value would
    // cross-contaminate). The crumb is always the trail head in
    // Baseline mode; fall back to 0 only for the defensive empty-
    // trail case so the lookup stays a no-op cache miss.
    const assetCrumbCustomerId =
      trail.length > 0 && trail[0].kind === "asset" ? trail[0].customerId : 0;
    for (const step of trail) {
      if (step.kind !== "dimension") continue;
      if (!isTier2ServerDimension(step.dimension)) continue;
      const cached = tier2.getCached(
        step.dimension,
        step.value.key,
        assetCrumbCustomerId,
      );
      if (!cached || cached.events.length === 0) continue;
      for (const ev of cached.events) {
        const key = tier2DedupeKey(ev);
        if (corpusKeys.has(key) || seen.has(key)) continue;
        seen.add(key);
        // Tier 2 fetch results are flat `TriageEvent[]` from the
        // Policy fetch service and do not carry a per-tenant marker.
        // Attribute the spliced events to the trail's asset crumb so
        // the pivot index's `(customerId, origAddr)` filter for the
        // asset step still resolves.
        out.push({
          ...ev,
          score: baselineScore(ev),
          customerId: assetCrumbCustomerId,
        });
      }
    }
    return out;
  }, [scope, trail, tier2, result.events]);

  const expandedEvents: readonly ScoredTriageEvent[] = useMemo(() => {
    // Story-origin trails (#553) replace the corpus entirely — the
    // pivot panel and the related-events surface read from the
    // Story's member set, not the period-wide events. Asset list
    // stays period-wide (see "Data-source scope" PR decision), so the
    // swap is local to this memo. Tier 2 expansion is not surfaced
    // for Story origin (Tier 2 fallback is asset-rooted in this PR;
    // see PR description), so the splice is unnecessary here.
    if (pivotOrigin.kind === "story") return storyMemberEvents;
    if (expandedTier2Events.length === 0) return result.events;
    return [...result.events, ...expandedTier2Events];
  }, [pivotOrigin, storyMemberEvents, result.events, expandedTier2Events]);

  // The Baseline-mode menu reads from `baseline_triaged_event` whose
  // row shape lacks the fields Policy-only dimensions consume
  // (country, userAgent, TLS subtype fields, dnsAnswer, clusterId).
  // Forcing mode="baseline" here keeps the panel honest about which
  // sections can produce a value — the index-builder skips Policy-only
  // dimensions entirely, so the panel never offers a click that would
  // resolve to an empty group.
  const pivotIndex = useMemo(
    () => pivotIndexFor(expandedEvents, "baseline"),
    [expandedEvents],
  );

  const focusEvents: ScoredTriageEvent[] = useMemo(() => {
    if (!activeStep) return [];
    // Static Tier-2-only dimensions (#498 — `learningMethods`) carry no
    // per-event extractor, so the pivot index has no bucket for them.
    // Resolve the focus directly from the cached Tier 2 fetch result;
    // those events are already spliced into `expandedEvents` above so
    // downstream client-intersection pivots still see them, but the
    // active-step focus needs an explicit lookup.
    if (
      activeStep.kind === "dimension" &&
      isStaticTier2Dimension(activeStep.dimension)
    ) {
      // Tier 2 fetch results lack a per-tenant marker; attribute them
      // to the trail's asset crumb so the synthesized pivot-focus row
      // can still identify the customer (see `expandedTier2Events`).
      // The same crumb keys the Tier 2 lookup so cross-tenant cache
      // entries cannot collide (#502).
      const assetCrumbCustomerId =
        trail.length > 0 && trail[0].kind === "asset" ? trail[0].customerId : 0;
      const cached = tier2.getCached(
        activeStep.dimension,
        activeStep.value.key,
        assetCrumbCustomerId,
      );
      if (!cached) return [];
      return cached.events.map((ev) => ({
        ...ev,
        score: baselineScore(ev),
        customerId: assetCrumbCustomerId,
      }));
    }
    return resolveStepFocusEvents(activeStep, expandedEvents, pivotIndex);
  }, [activeStep, expandedEvents, pivotIndex, tier2, trail]);

  // The "Save as Story" button (#490) is enabled only when every
  // focused event belongs to one customer — a curated Story is single-
  // tenant by #489 contract. The server enforces this too, but client
  // gating keeps the affordance honest in multi-customer scope.
  const saveAsStoryEnabled = useMemo(() => {
    if (focusEvents.length === 0) return false;
    const first = focusEvents[0].customerId;
    return focusEvents.every((e) => e.customerId === first);
  }, [focusEvents]);

  // When the active step is a dimension pivot, the issue says the
  // new "asset" view is the set of events sharing that value — not
  // the original asset. Synthesize a TriageAsset-shaped object from
  // the focus events so the same detail card renders, with the
  // dimension+value as the header and the focused events in the
  // table. The asset list still highlights the original anchor so
  // the operator can backtrack.
  //
  // Static Tier 2 dimensions (#498 / #499) keep the synthetic focus
  // card even when the server result is empty: `keywords` skips
  // corpus validation by design, so a valid search with zero matches
  // should land on a "Keywords: <value>" focus reporting zero counts
  // rather than falling back to the original asset detail (which
  // would leave only the breadcrumb hinting that anything changed).
  // Non-static dimensions still return null on an empty focus — for
  // those, an empty bucket can only arise from a stale hash where
  // the safer fallback is the asset card.
  const pivotFocusAsset: TriageAsset | null = useMemo(() => {
    if (!activeStep || activeStep.kind !== "dimension") return null;
    const assetCrumbCustomerId =
      trail.length > 0 && trail[0].kind === "asset" ? trail[0].customerId : 0;
    const isReadyStaticTier2 =
      isStaticTier2Dimension(activeStep.dimension) &&
      tier2.getCached(
        activeStep.dimension,
        activeStep.value.key,
        assetCrumbCustomerId,
      )?.status === "ready";
    if (focusEvents.length === 0 && !isReadyStaticTier2) return null;
    const dimensionLabel = labels.pivotPanel.dimensions[activeStep.dimension];
    const address = `${dimensionLabel}: ${activeStep.value.label}`;
    let triagedCount = 0;
    let scoreSum = 0;
    for (const ev of focusEvents) {
      if (ev.score > 0) triagedCount += 1;
      scoreSum += ev.score;
    }
    const sorted = [...focusEvents].sort((a, b) =>
      a.time === b.time ? 0 : a.time < b.time ? 1 : -1,
    );
    // Carry the CURRENT trail's asset crumb through to the synthetic
    // pivot-focus row so the detail header keeps identifying which
    // tenant the operator is inspecting, even after they select a non-
    // first asset row and pivot. Using `initialFocus` (which is always
    // `result.assets[0]`) would mis-label the tenant whenever the
    // selected asset is not the page's first row. The trail's first
    // crumb is set by `onSelectAsset` to the actively selected
    // `(customerId, address)`, so reading from there matches the user's
    // current selection. Falls back to a synthetic customerId 0 when
    // the trail has no asset crumb (rare — trail starts with a
    // dimension step on a hash-restored URL with no asset focus).
    const assetCrumb =
      trail.length > 0 && trail[0].kind === "asset" ? trail[0] : null;
    const focusedAsset = assetCrumb
      ? (result.assets.find(
          (a) =>
            a.customerId === assetCrumb.customerId &&
            a.address === assetCrumb.address,
        ) ?? null)
      : null;
    // Story-origin trails (#553) intentionally have no asset crumb, so
    // the customer identity must come from the Story origin itself.
    // Resolve the display name from the matching loaded Story
    // (`focusedStory` first, then the `stories` slice) before falling
    // back to the customer name carried on any loaded asset that
    // shares the customerId, and finally to the stringified
    // `customerId` — the same fallback shape `TriageAsset` documents.
    const storyOriginCustomerId =
      pivotOrigin.kind === "story" ? pivotOrigin.customerId : null;
    const storyOriginMatch =
      pivotOrigin.kind === "story"
        ? ((focusedStory?.customerId === pivotOrigin.customerId &&
          focusedStory?.storyId === pivotOrigin.storyId
            ? focusedStory
            : null) ??
          stories.find(
            (s) =>
              s.customerId === pivotOrigin.customerId &&
              s.storyId === pivotOrigin.storyId,
          ) ??
          null)
        : null;
    const storyOriginCustomerName =
      pivotOrigin.kind === "story"
        ? (storyOriginMatch?.customerName ??
          result.assets.find((a) => a.customerId === pivotOrigin.customerId)
            ?.customerName ??
          String(pivotOrigin.customerId))
        : null;
    return {
      // Synthetic asset row — `customerId` defaults to the asset crumb's
      // customer; for Story-origin trails (#553) there is no asset
      // crumb, so use the Story origin's `customerId` instead so the
      // detail header does not render `0` as the customer label. The
      // pivot focus card does not key off `customerId`, so the value
      // is purely structural.
      customerId: assetCrumb?.customerId ?? storyOriginCustomerId ?? 0,
      customerName:
        storyOriginCustomerName ??
        focusedAsset?.customerName ??
        String(assetCrumb?.customerId ?? 0),
      address,
      detectedCount: focusEvents.length,
      detectedCountUnavailable: false,
      triagedCount,
      score: scoreSum,
      lastEventTimeIso: sorted.length > 0 ? sorted[0].time : null,
      events: sorted.slice(0, PIVOT_FOCUS_DETAIL_EVENT_CAP),
    };
  }, [
    activeStep,
    focusEvents,
    labels.pivotPanel.dimensions,
    trail,
    result.assets,
    tier2,
    pivotOrigin,
    focusedStory,
    stories,
  ]);

  // Pivot focus is a Pivot-tab concept: it only re-skins the right-hand
  // detail panel into the synthetic dimension-focus card. On the Asset
  // list tab the panel must reflect the user's selected asset row
  // instead — otherwise switching to Asset list leaves the panel
  // labeled as a pivot focus the user can't see breadcrumbs for. The
  // trail itself is preserved across tab toggles so switching back to
  // Pivot restores the prior drill-in.
  //
  // Story-origin trails (#553) keep the synthetic pivot-focus card on
  // the Pivot tab. The asset-rooted fallback (`effectiveAsset`) is
  // suppressed — falling back to it would render an asset card the
  // breadcrumb cannot back, and during hash-restore that read as the
  // "asset-rooted state flash" the issue explicitly forbids.
  const detailAsset =
    tab === "pivot"
      ? pivotOrigin.kind === "story"
        ? pivotFocusAsset
        : (pivotFocusAsset ?? effectiveAsset)
      : effectiveAsset;

  const allSections = useMemo(
    () => buildPivotPanel(pivotIndex, focusEvents, { mode: "baseline" }),
    [pivotIndex, focusEvents],
  );

  // Tier-2-only dimensions (`kinds`, `categories`, `levels`) are
  // hidden in Tier 1 mode — their click action is a Tier 2 fetch and
  // surfacing them under Tier 1 would let the operator click a row
  // that goes nowhere. They reappear under the "Tier 2 only" group
  // when the toggle is on. As of #502 the `sameSensor` row is now
  // live in Tier 2 mode (the panel click resolves the sensor name to
  // REview's opaque `nodeId` against the shared lookup before
  // issuing the fetch), so no Tier 2 suppression is needed.
  const sections = useMemo(() => {
    const dimById = new Map<string, ReturnType<typeof getPivotDimension>>();
    const isTier2Only = (dim: string): boolean => {
      let known = dimById.get(dim);
      if (!known) {
        try {
          known = getPivotDimension(
            dim as Parameters<typeof getPivotDimension>[0],
          );
          dimById.set(dim, known);
        } catch {
          return false;
        }
      }
      return known.tier2Only === true;
    };
    if (scope !== "tier2" || pivotOrigin.kind === "story") {
      // Story-origin trails (#553) render Tier 1 panels only — Tier 2
      // suppression matches the "Tier 2 scope" PR design decision.
      return allSections.filter((s) => !isTier2Only(s.dimension));
    }
    return allSections;
  }, [allSections, scope, pivotOrigin]);

  // Surface truncation from both the Tier 1 loader (5,000-event corpus
  // cap, applied to the period) and any Tier 2 dimension fetch on the
  // trail (5,000-event per-dimension cap). Every server-filtered Tier 2
  // step on the trail contributes its events to `expandedTier2Events`
  // and therefore to the current panel, so a truncated ancestor still
  // taints downstream client-intersection pivots — the hint must follow
  // the contributing fetch results, not just the active step. Checking
  // only `activeStep` would let the hint disappear as soon as the
  // operator pivots from a capped `country=KR` fetch into a local-only
  // dimension like JA3, even though the JA3 panel is computed from
  // that same partial 5,000-row country result.
  const panelTruncated = useMemo(() => {
    if (result.truncated) return true;
    if (scope !== "tier2") return false;
    const assetCrumbCustomerId =
      trail.length > 0 && trail[0].kind === "asset" ? trail[0].customerId : 0;
    for (const step of trail) {
      if (step.kind !== "dimension") continue;
      if (!isTier2ServerDimension(step.dimension)) continue;
      const cached = tier2.getCached(
        step.dimension,
        step.value.key,
        assetCrumbCustomerId,
      );
      if (cached?.truncated === true) return true;
    }
    return false;
  }, [result.truncated, scope, trail, tier2]);

  // Cancel any hash-restore work still in flight. Explicit user
  // navigation (new asset, pivot click, crumb backtrack) replaces or
  // extends the trail the restore was driving; without aborting,
  // (a) the queued Tier 2 ancestor fetches would keep firing under the
  // restored asset's `customerId` even though the trail no longer
  // shows them, (b) the post-drain client-intersection validator would
  // run against a now-different trail and could fire
  // `revertToRestoredAssetRoot()` — surfacing the stale-hash banner on
  // top of the operator's fresh selection and trimming any pivot they
  // added in the meantime, and (c) `draining.current` would let the
  // next render dispatch a stale queued item even after the queue was
  // cleared. The reviewer's repro (#502 Round 7) is: hash-restore
  // `asset A → country=KR → ja3=abc`, click a different asset before
  // the queued `country=KR` resolves, then let it finish — the
  // deferred validator would otherwise still run.
  const abortHashRestore = useCallback(() => {
    pendingHashFetchesRef.current = [];
    pendingValidationsRef.current = [];
    draining.current = null;
    // Invalidate any in-flight Story-origin `fetchStoryDetail` so its
    // `.then` / `.catch` branches cannot overwrite the user's fresh
    // intent after the operator has navigated away from the restored
    // state. See {@link storyRestoreTokenRef}.
    storyRestoreTokenRef.current += 1;
  }, []);

  // Dismiss every modal-gated Tier 2 projection along with its parked
  // peek stash and loading entry. Called on *trail abandonment*
  // (selecting a different asset, backtracking via a crumb, clicking
  // the asset-root crumb) — not on extension (a fresh pivot click on
  // the same trail still queues behind any open modal, since that is
  // the intentional two-large-projection-per-trail behavior documented
  // at `use-tier2-pivot.ts`'s `pendingQueue` declaration). The
  // reviewer's Round 8 repro is: click a Tier 2 server dimension on
  // asset A whose first page trips the 20,000-event modal, then
  // select asset B before answering — without this the modal stays
  // open on B showing A's projection and Confirm would resume A's
  // parked stash under A's `(dimension, valueKey, customerId)` even
  // though the trail is now B's.
  const abortPendingTier2Projections = useCallback(() => {
    tier2.dismissAllPending();
  }, [tier2]);

  const onSelectAsset = useCallback(
    (focus: { customerId: number; address: string }) => {
      setSelected(focus);
      // Selecting a new asset replaces the trail — selecting from the
      // asset list is a "fresh start", not a pivot. Story-origin trails
      // are also abandoned when the analyst picks an asset row; the
      // asset list never silently switches origin so this is the
      // explicit transition back to the asset-rooted shape.
      setPivotOrigin({ kind: "asset" });
      setStoryMemberEvents([]);
      setTrail([
        {
          kind: "asset",
          customerId: focus.customerId,
          address: focus.address,
        },
      ]);
      // Any prior fallback notice described the previous trail; once
      // the operator moves to a fresh asset it would just be stale
      // copy on the page.
      setFallbackNotice(null);
      abortHashRestore();
      // The prior trail's modal-gated Tier 2 projection (if any) is
      // tied to its `(dimension, valueKey, customerId)` tuple; a
      // Confirm after the asset swap would resume work for the trail
      // the operator just left (#502 Round 8).
      abortPendingTier2Projections();
    },
    [abortHashRestore, abortPendingTier2Projections],
  );

  // Pivot-from-Story (#553). The Stories view fires this when the
  // analyst clicks a pivot dimension button on a member event row in
  // the Story detail panel. The handler:
  //   1. Adapts the Story's member-detail list into ScoredTriageEvent
  //      so the pivot index can build over the Story corpus.
  //   2. Flips `pivotOrigin` to `"story"` and seeds the trail with
  //      the chosen dimension step — no asset crumb is emitted (the
  //      origin acts as the root).
  //   3. Routes the analyst onto the Pivot peer view so the
  //      breadcrumb + related-events panel surfaces are visible.
  //   4. Clears the focused Story so a subsequent Stories↔Pivot tab
  //      swap can drop the Stories detail focus while the Pivot
  //      origin survives (the two states are independent post-#553).
  const onPivotFromStory = useCallback(
    (args: {
      story: TriageStory;
      members: readonly TriageStoryMemberDetail[];
      dimension: PivotDimensionId;
      value: PivotValue;
    }) => {
      const events = storyMembersToScoredEvents(
        args.members,
        args.story.customerId,
      );
      setStoryMemberEvents(events);
      setPivotOrigin({
        kind: "story",
        customerId: args.story.customerId,
        storyId: args.story.storyId,
      });
      setTrail([
        {
          kind: "dimension",
          dimension: args.dimension,
          value: args.value,
        },
      ]);
      setTab("pivot");
      setFocusedStory(null);
      setFallbackNotice(null);
      abortHashRestore();
      abortPendingTier2Projections();
    },
    [abortHashRestore, abortPendingTier2Projections],
  );

  // Click handler for the Story-origin breadcrumb segment. Returns
  // the analyst to the Story detail panel: re-focuses the Story on
  // the Stories tab, drops the Pivot trail, and resets the origin to
  // `"asset"` so the Pivot tab is no longer reachable from the
  // breadcrumb's now-cleared state. Mirrors the standard breadcrumb
  // "click an earlier crumb" semantics for the special root.
  const onSelectStoryOrigin = useCallback(() => {
    if (pivotOrigin.kind !== "story") return;
    const customerId = pivotOrigin.customerId;
    const storyId = pivotOrigin.storyId;
    setPivotOrigin({ kind: "asset" });
    setStoryMemberEvents([]);
    setTrail(
      initialFocus
        ? [
            {
              kind: "asset",
              customerId: initialFocus.customerId,
              address: initialFocus.address,
            },
          ]
        : [],
    );
    setFallbackNotice(null);
    abortHashRestore();
    // Re-focus the Story whose origin we just closed; the reconcile
    // effect promotes it to the loaded row when the prop slice
    // contains a matching `(customerId, storyId)`. A miss surfaces
    // through the existing stale-hash toast.
    const matched = stories.find(
      (s) => s.customerId === customerId && s.storyId === storyId,
    );
    if (matched) {
      setFocusedStory(matched);
    } else {
      setFocusedStory(null);
      setShowStaleStoryHash(true);
    }
    setTab("stories");
  }, [pivotOrigin, initialFocus, abortHashRestore, stories]);

  const onPivot = useCallback(
    (step: PivotStep) => {
      // In Tier 2 mode, clicking a server-filtered dimension issues a
      // fresh fetch alongside the breadcrumb update so the next render
      // can splice the expanded events into the panel. Tier 1 clicks
      // (and Tier 2 client-intersection dimensions) are local-only.
      //
      // Story-origin trails (#553) skip the Tier 2 dispatch entirely:
      // Tier 2 fallback paths read from the asset's event set and have
      // no plumbing for a Story-member corpus in this PR (per the PR's
      // "Tier 2 scope" design decision). Clicks on Tier 2-only dims
      // are filtered out at panel-section level below; this guard is
      // a belt-and-braces for the trail-append path.
      if (
        scope === "tier2" &&
        pivotOrigin.kind !== "story" &&
        step.kind === "dimension" &&
        isTier2ServerDimension(step.dimension)
      ) {
        // Tier 2 fetches need the asset crumb's `customerId` so the
        // `sameSensor` resolution path can disambiguate sensor names
        // (not unique across tenants) under the asset's customer
        // scope. The asset crumb is always the trail head when a
        // Tier 2 server-filtered dimension is clicked; absent that,
        // the trail's `effectiveSelection` carries the same value.
        const customerId =
          trail.length > 0 && trail[0].kind === "asset"
            ? trail[0].customerId
            : (effectiveSelection?.customerId ?? 0);
        tier2.startFetch(step.dimension, step.value.key, customerId);
      }
      setTrail((current) => appendPivotStep(current, step));
      // A subsequent pivot describes a new trail; any leftover
      // fallback notice from the prior trail would otherwise sit above
      // the panel claiming the URL or sensor scope is stale.
      setFallbackNotice(null);
      // The post-drain validator would otherwise revert the trail back
      // to the asset crumb (dropping the new pivot) if any deferred
      // client-intersection step failed to materialize — a user
      // continuing to navigate has already accepted the optimistic
      // restored trail, so the validator's automatic revert is no
      // longer appropriate.
      abortHashRestore();
    },
    [abortHashRestore, effectiveSelection, pivotOrigin, scope, tier2, trail],
  );

  const onCrumb = useCallback(
    (indexInclusive: number) => {
      setTrail((current) => backtrackPivotTrail(current, indexInclusive));
      // Backtracking is a deliberate navigation — clear any stale notice
      // so the operator sees a clean trail.
      setFallbackNotice(null);
      abortHashRestore();
      // Backtracking discards the trailing pivot crumbs; any modal
      // queued for one of those (now-removed) steps would otherwise
      // outlive the trail it was raised against (#502 Round 8).
      abortPendingTier2Projections();
    },
    [abortHashRestore, abortPendingTier2Projections],
  );

  // Free-form `keywords` submit (#499). Same dispatch path as a
  // dimension click (`onPivot` handles the Tier 2 fetch + trail
  // append), with an extra side-effect: the submitted value joins the
  // recent-chips list at most-recent position. The duplicate-of-recent
  // rule is handled by {@link appendRecentKeyword}, which moves an
  // existing chip to the head rather than adding a second copy.
  const onSubmitKeyword = useCallback(
    (value: string) => {
      setRecentKeywords((current) => appendRecentKeyword(current, value));
      onPivot({
        kind: "dimension",
        dimension: "keywords",
        value: { key: value, label: value },
      });
    },
    [onPivot],
  );

  // ── URL hash restore (client-only — Server Components cannot read
  // location.hash) ──
  const hashRestoreAttempted = useRef(false);
  // A single mutually-exclusive state describing the active fallback
  // notice — `"stale-hash"` for the URL-no-longer-matches-corpus case
  // (and the `name-unresolved` arm of a `sameSensor` pivot),
  // `"sensor-scope-forbidden"` for the `scope-forbidden` arm where the
  // resolved `nodeId` was rejected by review-web's tightened sensor-
  // scope check (#502). Modelling these as two independent booleans
  // previously let a `scope-forbidden` notice persist alongside a
  // subsequent `name-unresolved` (or vice versa) because nothing
  // cleared the prior flag; collapsing to a single string makes the
  // two arms mutually exclusive at the type level and lets a single
  // reset point clear whichever notice is active.
  type FallbackNotice = "stale-hash" | "sensor-scope-forbidden" | null;
  const [fallbackNotice, setFallbackNotice] = useState<FallbackNotice>(null);
  // Server-filtered steps decoded from the hash whose data still has
  // to be fetched after restore. The restore effect parses the hash
  // and seeds the trail, but `useTier2Pivot.startFetch` would no-op if
  // called before the parent's scope prop has flipped to `"tier2"`. A
  // separate effect drains this queue once `scope === "tier2"` is
  // committed, so a shared Tier 2 URL actually re-issues the trail's
  // server fetches (including the pre-fetch modal path when the
  // projection trips the threshold).
  const pendingHashFetchesRef = useRef<
    Array<{
      dimension: Tier2Dimension;
      valueKey: string;
      /**
       * Asset-root `customerId` captured at hash-restore time so the
       * Tier 2 fetch's `sameSensor` resolution path keys on the
       * restored asset's tenant, not the live selection at drain time.
       */
      customerId: number;
    }>
  >([]);
  // Client-intersection steps decoded from a Tier 2 hash whose value
  // was not present in the Tier 1 corpus on restore. The queued Tier 2
  // ancestor fetches may surface them once the cache populates; the
  // post-drain validation effect re-checks against the now-expanded
  // corpus and either keeps the trail or falls back to the asset
  // root. Without this deferred path a URL like
  // `asset → country=KR → ja3=abc` (where `abc` exists only in the
  // fetched country result) would always be treated as stale.
  const pendingValidationsRef = useRef<
    Array<{ dimension: PivotDimensionId; valueKey: string }>
  >([]);
  // Story-origin hash restore (#553) is asynchronous — `fetchStoryDetail`
  // resolves after the operator may have already abandoned the
  // restored state (selecting an asset, backtracking, clicking the
  // asset root crumb). Without a cancellation guard, the late-arriving
  // `.then` / `.catch` branches would unconditionally rewrite
  // `pivotOrigin`, `trail`, and `tab` — overwriting the fresh user
  // intent and surfacing a stale-hash banner on a state the operator
  // never asked to restore. The token is incremented by
  // `abortHashRestore()` (which is fired by every user-navigation
  // path), so the pre-fetch capture lets the resolve branches detect
  // that they are stale and bail out before any `setState` runs.
  const storyRestoreTokenRef = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: restore runs once after the corpus is in hand
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (hashRestoreAttempted.current) return;
    hashRestoreAttempted.current = true;
    const parsed = parseTriagePivotHash(window.location.hash);
    if (parsed.mode !== null) {
      onScopeRestoredFromHash?.(parsed.mode === "tier2" ? "tier2" : "tier1");
    }
    if (parsed.storyOriginStaleHash) {
      setFallbackNotice("stale-hash");
    }
    // Story-origin hash restore (#553). Mounts the Pivot tab onto the
    // Story corpus by fetching the Story's member set before painting
    // the breadcrumb. The asset-rooted restore path below is skipped
    // when a Story origin is present so the analyst does not see an
    // asset-rooted state flash before the Story origin lands (a
    // momentary loading state is acceptable per #553 acceptance).
    if (parsed.story !== null) {
      const origin = parsed.story;
      // Seed the visible state synchronously: Pivot tab, Story
      // origin, dimension steps as decoded. The dimension steps are
      // surfaced optimistically — `fetchStoryDetail` may discover the
      // value is absent from the loaded member set (stale link). The
      // pivot panel renders an empty section list until the member
      // set lands (the index is empty without `storyMemberEvents`),
      // which is the acceptable "loading/empty state during client
      // restore" #553 calls for — no asset-corpus surfaces leak.
      setPivotOrigin({
        kind: "story",
        customerId: origin.customerId,
        storyId: origin.storyId,
      });
      const restoredSteps: PivotStep[] = parsed.steps.map((step) => ({
        kind: "dimension" as const,
        dimension: step.dimension,
        value: { key: step.valueKey, label: step.valueKey },
      }));
      setTrail(restoredSteps);
      setTab("pivot");
      // Capture the cancellation token *before* the fetch so any user
      // navigation between issue and resolution invalidates this
      // restore — `abortHashRestore()` bumps the ref, and the resolve
      // branches below bail out when the captured value no longer
      // matches the live ref. Without this guard a slow restore could
      // race with a `setSelected` (asset list click) and later flip
      // `pivotOrigin` / `trail` / `tab` back to the restored state.
      const restoreToken = storyRestoreTokenRef.current;
      void fetchStoryDetail(origin.customerId, origin.storyId, 0, period)
        .then((detail) => {
          if (storyRestoreTokenRef.current !== restoreToken) return;
          if (detail === null) {
            // Story is gone (out of scope, deleted, period drift).
            // Revert to asset-rooted shape and surface the stale-hash
            // notice the same way the asset path does.
            setPivotOrigin({ kind: "asset" });
            setStoryMemberEvents([]);
            setTrail(
              initialFocus
                ? [
                    {
                      kind: "asset",
                      customerId: initialFocus.customerId,
                      address: initialFocus.address,
                    },
                  ]
                : [],
            );
            setTab("asset-list");
            setFallbackNotice("stale-hash");
            return;
          }
          const events = storyMembersToScoredEvents(
            detail.members,
            origin.customerId,
          );
          // Validate decoded dimension steps against the loaded
          // member set — a step whose value is absent from any member
          // is genuinely stale (the URL points at a value that no
          // longer matches the Story corpus). Revert to the Story
          // origin root in that case so the breadcrumb does not
          // claim a pivot the corpus cannot back.
          let stepsAreLive = true;
          for (const step of restoredSteps) {
            if (step.kind !== "dimension") continue;
            let dim: ReturnType<typeof getPivotDimension>;
            try {
              dim = getPivotDimension(step.dimension);
            } catch {
              stepsAreLive = false;
              break;
            }
            const found = events.some((ev) =>
              dim.extract(ev).some((v) => v.key === step.value.key),
            );
            if (!found) {
              stepsAreLive = false;
              break;
            }
          }
          setStoryMemberEvents(events);
          if (!stepsAreLive) {
            setTrail([]);
            setFallbackNotice("stale-hash");
          }
        })
        .catch(() => {
          if (storyRestoreTokenRef.current !== restoreToken) return;
          setPivotOrigin({ kind: "asset" });
          setStoryMemberEvents([]);
          setTrail(
            initialFocus
              ? [
                  {
                    kind: "asset",
                    customerId: initialFocus.customerId,
                    address: initialFocus.address,
                  },
                ]
              : [],
          );
          setTab("asset-list");
          setFallbackNotice("stale-hash");
        });
      return;
    }
    // The parser drops malformed / out-of-whitelist `triage.pivot.step`
    // segments silently, but counts them so the restore path can
    // distinguish "no step in URL" from "step was present but
    // rejected" — the latter must fall back to the asset root with the
    // stale-hash toast (#498 negative-path requirement). Surfaces here
    // before the early-return below, otherwise a URL like
    // `?asset=...&step=learningMethods:INVALID` would silently restore
    // the asset without warning the operator that part of their shared
    // link was unusable.
    const hadRejectedSteps = parsed.rejectedStepCount > 0;
    if (parsed.asset === null && parsed.steps.length === 0) {
      if (hadRejectedSteps) setFallbackNotice("stale-hash");
      return;
    }
    // Resolve the asset against the freshly-loaded corpus. The hash
    // carries a composite `customerId/address`; a legacy URL with the
    // bare address (`customerId === null`) is treated as stale rather
    // than mis-resolving against the first customer's matching
    // address. If `customerId` is present, the lookup must match
    // BOTH parts of the composite key.
    let restoredAsset: { customerId: number; address: string } | null = null;
    if (parsed.asset !== null) {
      if (parsed.asset.customerId === null) {
        setFallbackNotice("stale-hash");
        return;
      }
      const found = result.assets.find(
        (a) =>
          a.customerId === parsed.asset?.customerId &&
          a.address === parsed.asset?.address,
      );
      if (!found) {
        setFallbackNotice("stale-hash");
        return;
      }
      restoredAsset = { customerId: found.customerId, address: found.address };
    }
    if (restoredAsset === null) return;
    if (hadRejectedSteps) {
      // Asset resolved but at least one step was rejected: restore the
      // breadcrumb to the asset crumb only and surface the stale-hash
      // toast — matches the semantics of the post-drain validation
      // path so the operator sees one consistent fallback.
      setSelected(restoredAsset);
      setTrail([
        {
          kind: "asset",
          customerId: restoredAsset.customerId,
          address: restoredAsset.address,
        },
      ]);
      setFallbackNotice("stale-hash");
      return;
    }
    const restoredTrail: PivotStep[] = [
      {
        kind: "asset",
        customerId: restoredAsset.customerId,
        address: restoredAsset.address,
      },
    ];
    let stale = false;
    const refetchQueue: Array<{
      dimension: Tier2Dimension;
      valueKey: string;
      customerId: number;
    }> = [];
    const deferredValidations: Array<{
      dimension: PivotDimensionId;
      valueKey: string;
    }> = [];
    const inTier2Mode = parsed.mode === "tier2";
    // Validation rules per (mode × dimension class):
    //   - Tier 2-only server dim: cannot be resolved from the Tier 1
    //     corpus; restore with raw valueKey, queue a Tier 2 fetch.
    //   - Tier 1-overlapping server dim in Tier 2 mode: queue a fetch
    //     and skip Tier 1 corpus validation — the click action in
    //     Tier 2 is a fresh fetch, so requiring corpus presence would
    //     reject perfectly valid shared URLs whose value is rare in
    //     the loaded corpus.
    //   - Tier 1-overlapping server dim in Tier 1 mode: must be in the
    //     corpus, otherwise stale.
    //   - Client-intersection dim in Tier 2 mode: may exist only in a
    //     server-filtered ancestor's Tier 2 fetch result. Restore the
    //     step, defer validation until after the queue drains, and
    //     fall back to the asset root only if still missing then.
    //   - Client-intersection dim in Tier 1 mode: strict corpus check.
    for (const step of parsed.steps) {
      const isStaticDim = isStaticTier2Dimension(step.dimension);
      let dim: ReturnType<typeof getPivotDimension> | null = null;
      if (!isStaticDim) {
        try {
          dim = getPivotDimension(step.dimension);
        } catch {
          stale = true;
          break;
        }
      }
      // Static Tier-2-only dims have no `PivotDimension` entry but ARE
      // Tier-2-only by construction (#498). Treat them as such so the
      // restore validation skips the corpus presence check the same
      // way it does for the `tier2Only` flag on existing dims.
      const isTier2Only = isStaticDim || dim?.tier2Only === true;
      const isServerDim = isTier2ServerDimension(step.dimension);
      let label = step.valueKey;
      let found = false;
      if (dim) {
        for (const ev of result.events) {
          const values = dim.extract(ev);
          const hit = values.find((v) => v.key === step.valueKey);
          if (hit) {
            label = hit.label;
            found = true;
            break;
          }
        }
      } else if (isStaticDim && step.dimension === "learningMethods") {
        // The localized button label lives in the panel labels record.
        // Without this, the restored breadcrumb crumb and pivot-focus
        // header would show the raw enum literal instead of the
        // operator-facing string.
        const valueLabels = labels.pivotPanel.learningMethodValues;
        if (valueLabels) {
          const localized =
            valueLabels[step.valueKey as keyof typeof valueLabels];
          if (localized) label = localized;
        }
      }
      if (!found) {
        if (inTier2Mode && (isServerDim || isTier2Only)) {
          // Server-filtered step in Tier 2 — the queued fetch will
          // populate the result; do not require corpus presence.
        } else if (inTier2Mode) {
          // Client-intersection in Tier 2 — defer validation to the
          // post-drain effect. Restore optimistically.
          deferredValidations.push({
            dimension: step.dimension,
            valueKey: step.valueKey,
          });
        } else {
          stale = true;
          break;
        }
      }
      restoredTrail.push({
        kind: "dimension",
        dimension: step.dimension,
        value: { key: step.valueKey, label },
      });
      // Server-filtered steps need an actual Tier 2 fetch on restore —
      // the breadcrumb alone gives the operator a misleadingly empty
      // panel computed against the Tier 1 corpus only. Queue them now;
      // the drain effect dispatches once Tier 2 mode is enabled. The
      // inline type guard keeps `Tier2Dimension` narrowing in scope —
      // hoisting it into `isServerDim` would lose the narrowing on
      // `step.dimension`.
      if (inTier2Mode && isTier2ServerDimension(step.dimension)) {
        refetchQueue.push({
          dimension: step.dimension,
          valueKey: step.valueKey,
          customerId: restoredAsset.customerId,
        });
      }
    }
    if (stale) {
      setFallbackNotice("stale-hash");
      return;
    }
    setSelected(restoredAsset);
    setTrail(restoredTrail);
    // A URL hash that carries at least one dimension pivot beyond the
    // asset crumb is a pivoted state — route the operator onto the
    // Pivot peer view so the restored breadcrumb + related-events
    // panel are actually visible. A pure asset hash leaves the
    // default Asset list tab in place.
    if (restoredTrail.some((step) => step.kind === "dimension")) {
      setTab("pivot");
    }
    if (refetchQueue.length > 0) {
      pendingHashFetchesRef.current = refetchQueue;
    }
    if (deferredValidations.length > 0) {
      pendingValidationsRef.current = deferredValidations;
    }
  }, [result.assets, result.events]);

  // Drain the hash-restore Tier 2 fetch queue once the scope prop has
  // actually flipped to `"tier2"`. The hook's `startFetch` short-circuits
  // when its `enabled` flag is `false` (which mirrors `scope`), so this
  // wait is required even when the hash carried `mode=tier2`.
  //
  // The drain runs **serially** through the existing pre-fetch modal
  // path — the hook keeps a single `peekStashRef` / `pending` slot, so
  // firing every queued step at once would let a later peek's stash
  // overwrite an earlier one when both projections trip the modal,
  // leaving the earlier fetch stuck in `loading` with no confirm/cancel
  // affordance. We instead pop one item, wait for it to leave the
  // pending/loading state, then pop the next. The effect re-runs on
  // changes to `scope`, the hook's `pending`, `inFlight`, and `errors`
  // — those collectively cover both modal-gated and silent completions.
  const draining = useRef<{
    dimension: Tier2Dimension;
    valueKey: string;
    customerId: number;
  } | null>(null);
  // `tier2.inFlight` and `tier2.errors` are listed as deps so the
  // effect re-runs when the currently-draining fetch resolves
  // (loading → ready or loading → error). The body does not read them
  // directly — it consults `tier2.getCached(...)` instead — but without
  // them in the deps list the next queued item never fires. Biome's
  // exhaustive-deps reports them as removable; the suppression below
  // documents the rerun trigger contract.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps drive the serial drain rerun trigger
  useEffect(() => {
    if (scope !== "tier2") return;
    if (tier2.pending !== null) return;
    if (draining.current !== null) {
      const status = tier2.getCached(
        draining.current.dimension,
        draining.current.valueKey,
        draining.current.customerId,
      );
      // Still loading (or modal-gated through `pending`, handled
      // above): wait for the next render.
      if (status?.status === "loading") return;
      // A queued ancestor fetch landed in error: surface only the
      // error notice, not also the stale-hash toast / asset-root
      // reset. #502 says lookup/fetch failures take the standard
      // error banner path, so abort the rest of the restore chain —
      // both the remaining queued fetches (whose corpus context is
      // already incomplete) and the deferred client-intersection
      // validations (which would otherwise misclassify a missing
      // value as genuinely stale and fire `revertToRestoredAssetRoot`
      // on top of the error).
      if (status?.status === "error") {
        pendingHashFetchesRef.current = [];
        pendingValidationsRef.current = [];
      }
      // A queued `sameSensor` ancestor resolved to a sensor-scope
      // fallback (`name-unresolved` or `scope-forbidden`): the hook
      // intentionally deletes the loading entry and queues the
      // fallback instead of writing `ready` / `error`, so `status`
      // is `null` here. The fallback effect below will trim the trail
      // to the asset root and render the distinct fallback notice,
      // but without this branch the drain would keep firing queued
      // descendants (their corpus context is already incomplete) and
      // the post-drain validator would run against the reverted trail
      // and overwrite the fallback notice with the generic stale-hash
      // banner. Treat the fallback case like `error` and abort the
      // rest of the restore chain.
      if (
        !status &&
        draining.current.dimension === "sameSensor" &&
        tier2.sensorFallbacks.some(
          (f) =>
            f.sensorName === draining.current?.valueKey &&
            f.customerId === draining.current.customerId,
        )
      ) {
        pendingHashFetchesRef.current = [];
        pendingValidationsRef.current = [];
      }
      // Either ready, errored, or cleared via cancel: this slot is
      // free again. Fall through to fire the next queued item.
      draining.current = null;
    }
    if (pendingHashFetchesRef.current.length === 0) return;
    const next = pendingHashFetchesRef.current.shift();
    if (!next) return;
    draining.current = next;
    tier2.startFetch(next.dimension, next.valueKey, next.customerId);
  }, [scope, tier2, tier2.pending, tier2.inFlight, tier2.errors]);

  // Validate deferred client-intersection steps once the Tier 2 fetch
  // queue has fully drained. The expanded corpus now contains every
  // server-filtered ancestor's fetched events, so a step like
  // `ja3=abc` reachable only through a `country=KR` fetch can be
  // checked here. Steps still missing after the queue settles are
  // genuinely stale: revert to the asset root with the same toast as
  // the synchronous restore path.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps drive the post-drain rerun
  useEffect(() => {
    if (scope !== "tier2") return;
    if (tier2.pending !== null) return;
    if (draining.current !== null) return;
    if (pendingHashFetchesRef.current.length > 0) return;
    if (pendingValidationsRef.current.length === 0) return;
    const validations = pendingValidationsRef.current;
    pendingValidationsRef.current = [];
    // Stale-restore fallback for the deferred validator: trim the trail
    // back to the restored asset crumb, NOT the page's first asset.
    // Using `initialFocus` (always `result.assets[0]`) would jump the
    // UI to the wrong tenant/asset when the shared URL was restored
    // onto any non-first asset row. The current trail already carries
    // the resolved asset crumb at index 0 (set by the synchronous hash
    // restore at line 768), so reuse it.
    const revertToRestoredAssetRoot = () => {
      setTrail((current) => {
        const assetIndex = current.findIndex((s) => s.kind === "asset");
        if (assetIndex < 0) return current;
        return current.slice(0, assetIndex + 1);
      });
      setFallbackNotice("stale-hash");
    };
    for (const { dimension, valueKey } of validations) {
      let dim: ReturnType<typeof getPivotDimension>;
      try {
        dim = getPivotDimension(dimension);
      } catch {
        // Dimension was removed since the URL was produced — stale.
        revertToRestoredAssetRoot();
        return;
      }
      let found = false;
      for (const ev of expandedEvents) {
        const values = dim.extract(ev);
        if (values.some((v) => v.key === valueKey)) {
          found = true;
          break;
        }
      }
      if (!found) {
        revertToRestoredAssetRoot();
        return;
      }
    }
  }, [scope, tier2.pending, tier2.inFlight, tier2.errors, expandedEvents]);

  // Tier 2 `sameSensor` pivots that cannot complete against the
  // asset's customer scope (name-unresolved or scope-forbidden, see
  // #502) revert the trail to the asset root and surface a
  // non-blocking notice. The two arms render distinct copy:
  //   - `name-unresolved` — name does not map under the asset's
  //     tenant; routes through the existing stale-URL notice.
  //   - `scope-forbidden` — REview tightened scope mid-session and
  //     rejected the resolved `nodeId`; routes through the new
  //     "no longer accessible" notice so the operator can tell the
  //     two failure modes apart (#502 round 5 review).
  //
  // A queued fallback may resolve AFTER the operator has navigated
  // away from the trail that produced it — e.g. pivot
  // `sameSensor=edge-01` on asset A, immediately switch to asset B,
  // then let A's lookup land in the queue. The fallback's
  // `(sensorName, customerId)` identity is recorded at startFetch
  // time (#502 Round 6), so we can detect "no longer current" by
  // checking that the trail still describes the same pivot: the
  // asset crumb's customer matches and a `sameSensor` step for that
  // name is still on the trail. If not, ack-and-drop the fallback
  // silently — it would otherwise trim the unrelated current trail
  // back to its asset crumb and render A's banner on top of B's view
  // (#502 Round 7).
  useEffect(() => {
    if (tier2.sensorFallbacks.length === 0) return;
    const fallback = tier2.sensorFallbacks[0];
    const assetCrumb =
      trail.length > 0 && trail[0].kind === "asset" ? trail[0] : null;
    const trailOwnsFallback =
      assetCrumb !== null &&
      assetCrumb.customerId === fallback.customerId &&
      trail.some(
        (s) =>
          s.kind === "dimension" &&
          s.dimension === "sameSensor" &&
          s.value.key === fallback.sensorName,
      );
    if (!trailOwnsFallback) {
      tier2.acknowledgeSensorFallback(
        fallback.kind,
        fallback.sensorName,
        fallback.customerId,
      );
      return;
    }
    setTrail((current) => {
      // Trim back to the first asset crumb so the failed sensor step
      // (and anything past it) is removed. If the trail is empty
      // somehow, leave it alone — defensive only.
      const assetCrumbIndex = current.findIndex((s) => s.kind === "asset");
      if (assetCrumbIndex < 0) return current;
      return current.slice(0, assetCrumbIndex + 1);
    });
    if (fallback.kind === "scope-forbidden") {
      setFallbackNotice("sensor-scope-forbidden");
    } else {
      setFallbackNotice("stale-hash");
    }
    tier2.acknowledgeSensorFallback(
      fallback.kind,
      fallback.sensorName,
      fallback.customerId,
    );
  }, [tier2, trail]);

  // ── URL hash sync (write-side) ──
  // Persist the breadcrumb + scope into the URL hash whenever they
  // change. Foreign hash keys (#471 strictness) are preserved. Pivot
  // dimension steps are only persisted while the Pivot tab is active —
  // an analyst who pivots, then switches to Asset list, must not have
  // the now-hidden trail rewritten into the URL (which would forcibly
  // route the next reload back into the Pivot tab via the restore
  // effect). The asset crumb itself is left to the trail; only the
  // dimension-step persistence is gated.
  //
  // The Story-origin marker (#553) is persisted on a separate axis:
  // it survives the Pivot→Stories→Pivot tab swap, so when the trail
  // is hidden (asset-list tab) the dimension steps are stripped but
  // the `triage.pivot.story` marker stays. The Stories tab itself
  // clears its `triage.story` focus on swap; the two keys are
  // independent by design.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const persistedTrail =
      tab === "pivot"
        ? trail
        : trail.filter((step) => step.kind !== "dimension");
    const storyOrigin =
      pivotOrigin.kind === "story"
        ? {
            customerId: pivotOrigin.customerId,
            storyId: pivotOrigin.storyId,
          }
        : null;
    const hashState = pivotHashFromTrail(
      persistedTrail,
      scopeToHashMode(scope),
      storyOrigin,
    );
    const next = replaceTriagePivotHash(window.location.hash, hashState);
    const target = next.length > 0 ? `#${next}` : "";
    if (target === window.location.hash) return;
    // Use replaceState so each pivot click does not push a new
    // history entry — the breadcrumb already supports backtrack.
    const url = `${window.location.pathname}${window.location.search}${target}`;
    window.history.replaceState(null, "", url);
  }, [trail, scope, tab, pivotOrigin]);

  return (
    <div className="space-y-6">
      {fallbackNotice === "stale-hash" ? (
        <p
          role="status"
          className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200"
        >
          {labels.staleHashFallback}
        </p>
      ) : null}
      {fallbackNotice === "sensor-scope-forbidden" ? (
        <p
          role="status"
          className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200"
        >
          {labels.sensorScopeForbiddenFallback}
        </p>
      ) : null}
      <Tier2EvictionNotice
        evictions={tier2.evictions}
        onDismiss={tier2.acknowledgeEviction}
        labels={labels.tier2Eviction}
      />
      <Tier2ProgressNotice
        inFlight={tier2.inFlight}
        labels={labels.tier2Progress}
      />
      <Tier2ErrorNotice
        errors={tier2.errors}
        onDismiss={tier2.acknowledgeError}
        labels={labels.tier2Error}
      />
      <Tier2PrefetchModal
        open={tier2.pending !== null}
        projectedCount={tier2.pending?.totalCount ?? null}
        approximateMinimum={tier2.pending?.approximateMinimum ?? null}
        threshold={TIER2_PREFETCH_MODAL_THRESHOLD}
        onConfirm={tier2.confirmFetch}
        onCancel={tier2.cancelFetch}
        labels={labels.tier2Modal}
      />
      <TriageTabStrip
        tab={tab}
        mode={mode}
        onChange={(next) => {
          setTab(next);
          // Switching away from Stories clears the focused story so
          // the URL hash does not retain a focus the user did not ask
          // for after a tab toggle.
          if (next !== "stories") {
            setFocusedStory(null);
            setShowStaleStoryHash(false);
          }
        }}
        labels={labels.tabStrip}
      />
      {savedToastVisible ? (
        <p
          role="status"
          data-testid="triage-save-as-story-toast"
          className="rounded-md border border-emerald-300/60 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-950/40 dark:text-emerald-200"
        >
          <button
            type="button"
            onClick={() => {
              setTab("stories");
              setSavedToastVisible(false);
            }}
            className="underline underline-offset-2"
          >
            {labels.saveAsStory.successToast}
          </button>
        </p>
      ) : null}
      {tab === "stories" ? (
        <TriageStoriesView
          stories={stories}
          truncated={storiesTruncated}
          focused={focusedStory}
          onFocus={(s) => {
            setFocusedStory(s);
            if (s === null) setShowStaleStoryHash(false);
          }}
          showStaleHashWarning={showStaleStoryHash}
          period={period}
          loadDetail={async ({ customerId, storyId, storedMemberCount }) =>
            fetchStoryDetail(customerId, storyId, storedMemberCount, period)
          }
          refreshStories={(options) => refreshTriageStories(period, options)}
          onPivotFromStory={onPivotFromStory}
          labels={labels.stories}
        />
      ) : null}
      {tab !== "stories" ? (
        <TriageFunnelView funnel={result.funnel} labels={labels.funnel} />
      ) : null}
      {tab !== "stories" ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          {/*
           * Asset list + detail are shown on BOTH peer views: on the
           * Asset list tab they are the whole surface; on the Pivot tab
           * they stay visible so the analyst can switch to a different
           * asset mid-drill (the Tier 2 abandonment paths in
           * #502 / #use-tier2-pivot rely on the asset list buttons
           * remaining clickable while a pivot is in flight). Asset list
           * and Pivot are still distinct: the Pivot tab is what adds
           * the breadcrumb + related-events panel + Save-as-Story
           * affordance below.
           */}
          <TriageAssetListView
            assets={result.assets}
            selected={effectiveSelection}
            observedDenominatorTruncated={result.observedDenominatorTruncated}
            onSelect={onSelectAsset}
            labels={labels.assetList}
          />
          <TriageAssetDetailView
            asset={detailAsset}
            isPivotFocus={tab === "pivot" && pivotFocusAsset !== null}
            labels={labels.assetDetail}
          />
        </div>
      ) : null}
      {tab === "pivot" ? (
        <div className="space-y-3">
          {trail.length > 0 || pivotOrigin.kind === "story" ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <TriagePivotBreadcrumb
                trail={trail}
                origin={pivotOrigin}
                onSelect={(idx) => {
                  if (idx === 0 && pivotOrigin.kind === "asset") {
                    setTrail((current) => clearPivotTrail(current));
                    setFallbackNotice(null);
                    abortHashRestore();
                    // The asset-root crumb click clears every pivot
                    // from the trail — any modal-gated Tier 2
                    // projection queued for one of those pivots would
                    // otherwise outlive its trail (#502 Round 8).
                    abortPendingTier2Projections();
                  } else {
                    onCrumb(idx);
                  }
                }}
                onSelectStoryOrigin={onSelectStoryOrigin}
                labels={labels.pivotBreadcrumb}
              />
              {hasPivotedAwayFromAsset(trail) && focusEvents.length > 0 ? (
                <button
                  type="button"
                  data-testid="triage-save-as-story-button"
                  data-action="save-as-story"
                  disabled={!saveAsStoryEnabled}
                  title={
                    saveAsStoryEnabled
                      ? undefined
                      : labels.saveAsStory.disabledMultiCustomer
                  }
                  onClick={() => setSaveAsStoryOpen(true)}
                  className="rounded-sm border border-border bg-background px-3 py-1 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:text-muted-foreground"
                >
                  {labels.saveAsStory.button}
                </button>
              ) : null}
            </div>
          ) : null}
          <TriagePivotPanel
            sections={sections}
            truncated={panelTruncated}
            hasFocus={focusEvents.length > 0}
            onPivot={onPivot}
            labels={labels.pivotPanel}
            isWeakSignal={
              scope === "tier2"
                ? (event) => !tier2.isInTier1Corpus(event)
                : undefined
            }
            showLearningMethodSection={scope === "tier2"}
            showKeywordsSection={scope === "tier2"}
            recentKeywords={recentKeywords}
            onSubmitKeyword={onSubmitKeyword}
          />
        </div>
      ) : null}
      <TriageSaveAsStoryModal
        open={saveAsStoryOpen}
        onOpenChange={setSaveAsStoryOpen}
        focusEvents={focusEvents}
        period={period}
        onSaved={({ customerId, storyId }) => {
          setSaveAsStoryOpen(false);
          setSavedToastVisible(true);
          // Route the operator to the Stories tab with the newly-saved
          // Story focused. The synthetic story below is a transient
          // placeholder so the detail panel has something to render
          // until the Server Component re-runs `loadStoriesForPeriod`
          // and the real row arrives in `stories`; the reconciliation
          // effect above swaps the placeholder for the loaded row.
          // `router.refresh()` is what actually triggers the re-fetch
          // — without it the new Story would never appear in the list.
          setTab("stories");
          // Mark the current `stories` reference as the placeholder's
          // pre-refresh prop. The reconciliation effect will skip
          // clearing focus while it still sees this same reference,
          // then consume the gate on the first rotation past it (the
          // server refresh below). Without this gate, the effect runs
          // synchronously with the pre-refresh prop, finds no match
          // for the synthetic id, and clears focus before the new row
          // even arrives.
          placeholderRotationGateRef.current = stories;
          setFocusedStory({
            customerId,
            customerName: String(customerId),
            storyId,
            kind: "analyst_curated",
            ruleId: null,
            storyVersion: "v1",
            timeWindowStartIso: period.startIso,
            timeWindowEndIso: period.endIso,
            primaryAsset: null,
            score: null,
            summary: {
              kindHistogram: {},
              categoryHistogram: {},
              memberCount: focusEvents.length,
              durationMs: 0,
              distinctAssetCount: 0,
              topRawScore: 0,
            },
            createdAtIso: new Date().toISOString(),
            lastSentAtIso: null,
            sendCount: 0,
            topMembers: [],
          });
          router.refresh();
        }}
        submit={(input) => submitSaveAnalystCuratedStory(input, period)}
        labels={labels.saveAsStory}
      />
    </div>
  );
}
