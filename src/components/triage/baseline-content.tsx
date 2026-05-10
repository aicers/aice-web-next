"use client";

/**
 * Baseline-mode body of the Triage page. Phase 1.A — discussion #447
 * §6 deprecatable seam: this subtree must NOT import any policy
 * module so removing the mode toggle reduces the page to baseline-
 * only with a one-line edit.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ScoredTriageEvent,
  TriageAsset,
  TriageLoadResult,
  TriagePeriod,
} from "@/lib/triage";
import {
  appendPivotStep,
  backtrackPivotTrail,
  buildPivotPanel,
  clearPivotTrail,
  getPivotDimension,
  hasPivotedAwayFromAsset,
  type PivotStep,
  pivotIndexFor,
  resolveStepFocusEvents,
} from "@/lib/triage/pivot";
import { baselineScore } from "@/lib/triage/scoring";
import { tier2DedupeKey } from "@/lib/triage/tier2-cache";
import { isTier2ServerDimension } from "@/lib/triage/tier2-filter";
import {
  parseTriagePivotHash,
  pivotHashFromTrail,
  replaceTriagePivotHash,
  type TriagePivotMode,
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

export interface TriageBaselineLabels {
  funnel: TriageFunnelLabels;
  assetList: TriageAssetListLabels;
  assetDetail: TriageAssetDetailLabels;
  pivotPanel: TriagePivotPanelLabels;
  pivotBreadcrumb: TriagePivotBreadcrumbLabels;
  tier2Modal: Tier2PrefetchModalLabels;
  tier2Eviction: Tier2EvictionNoticeLabels;
  tier2Error: Tier2ErrorNoticeLabels;
  staleHashFallback: string;
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
  labels,
}: TriageBaselineContentProps) {
  const tier2 = useTier2Pivot({
    periodStartIso: period.startIso,
    periodEndIso: period.endIso,
    customerScope,
    enabled: scope === "tier2",
    tier1Corpus: result.events,
  });
  const initialAddress = result.assets[0]?.address ?? null;
  const [selectedAddress, setSelectedAddress] = useState<string | null>(
    initialAddress,
  );
  const [trail, setTrail] = useState<PivotStep[]>(() =>
    initialAddress ? [{ kind: "asset", address: initialAddress }] : [],
  );

  const selectedAsset = useMemo(() => {
    if (!selectedAddress) return null;
    return result.assets.find((a) => a.address === selectedAddress) ?? null;
  }, [result.assets, selectedAddress]);

  const effectiveSelection =
    selectedAsset === null && initialAddress !== null
      ? initialAddress
      : selectedAddress;
  const effectiveAsset =
    selectedAsset ?? (initialAddress ? (result.assets[0] ?? null) : null);

  // When the loaded result rotates (period change → new corpus), the
  // breadcrumb must reset to the new asset root. The parent already
  // confirms with the operator before triggering the period change,
  // so this effect just applies the cleared state. `resetSignal` is
  // listed as a dep because a confirm-then-reload may keep the same
  // initialAddress (when the new period happens to surface the same
  // top asset) yet still need to clear the trail.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetSignal is the trigger
  useEffect(() => {
    setSelectedAddress(initialAddress);
    setTrail(
      initialAddress ? [{ kind: "asset", address: initialAddress }] : [],
    );
  }, [initialAddress, resetSignal]);

  useEffect(() => {
    onPivotTrailChange?.(hasPivotedAwayFromAsset(trail));
  }, [trail, onPivotTrailChange]);

  const activeStep = trail.length > 0 ? trail[trail.length - 1] : null;

  // When the active step is a Tier 2 server-filter dimension, splice
  // any cached fetch results into the corpus so the pivot index sees
  // the expanded set. The merge is a no-op in Tier 1 mode, on Tier 2
  // dimensions without a cache hit, or when scoping is back at the
  // asset root.
  const activeStepTier2Events: ScoredTriageEvent[] = useMemo(() => {
    if (scope !== "tier2" || !activeStep || activeStep.kind !== "dimension") {
      return [];
    }
    if (!isTier2ServerDimension(activeStep.dimension)) return [];
    const cached = tier2.getCached(activeStep.dimension, activeStep.value.key);
    if (!cached || cached.events.length === 0) return [];
    const corpusKeys = new Set<string>();
    for (const ev of result.events) corpusKeys.add(tier2DedupeKey(ev));
    const out: ScoredTriageEvent[] = [];
    for (const ev of cached.events) {
      if (corpusKeys.has(tier2DedupeKey(ev))) continue;
      out.push({ ...ev, score: baselineScore(ev) });
    }
    return out;
  }, [scope, activeStep, tier2, result.events]);

  const expandedEvents: readonly ScoredTriageEvent[] = useMemo(() => {
    if (activeStepTier2Events.length === 0) return result.events;
    return [...result.events, ...activeStepTier2Events];
  }, [result.events, activeStepTier2Events]);

  const pivotIndex = useMemo(
    () => pivotIndexFor(expandedEvents),
    [expandedEvents],
  );

  const focusEvents: ScoredTriageEvent[] = useMemo(() => {
    if (!activeStep) return [];
    return resolveStepFocusEvents(activeStep, expandedEvents, pivotIndex);
  }, [activeStep, expandedEvents, pivotIndex]);

  // When the active step is a dimension pivot, the issue says the
  // new "asset" view is the set of events sharing that value — not
  // the original asset. Synthesize a TriageAsset-shaped object from
  // the focus events so the same detail card renders, with the
  // dimension+value as the header and the focused events in the
  // table. The asset list still highlights the original anchor so
  // the operator can backtrack.
  const pivotFocusAsset: TriageAsset | null = useMemo(() => {
    if (!activeStep || activeStep.kind !== "dimension") return null;
    if (focusEvents.length === 0) return null;
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
    return {
      address,
      detectedCount: focusEvents.length,
      triagedCount,
      score: scoreSum,
      events: sorted.slice(0, PIVOT_FOCUS_DETAIL_EVENT_CAP),
    };
  }, [activeStep, focusEvents, labels.pivotPanel.dimensions]);

  const detailAsset = pivotFocusAsset ?? effectiveAsset;

  const allSections = useMemo(
    () => buildPivotPanel(pivotIndex, focusEvents),
    [pivotIndex, focusEvents],
  );

  // In Tier 2 mode the `sameSensor` row is hidden until a `triage:read`
  // -compatible sensor name→ID lookup ships (#453). The Tier 1 click
  // action would still be valid, but mixing the two would mislead
  // operators about what the row's pivot button will do. The panel
  // surfaces a disabled placeholder with the "requires sensor index"
  // tooltip so the operator can tell the row is intentionally absent.
  const sections = useMemo(() => {
    if (scope !== "tier2") return allSections;
    return allSections.filter((s) => s.dimension !== "sameSensor");
  }, [allSections, scope]);
  const sensorDeferredInTier2 = useMemo(() => {
    if (scope !== "tier2") return false;
    return allSections.some((s) => s.dimension === "sameSensor");
  }, [allSections, scope]);

  const onSelectAsset = useCallback((address: string) => {
    setSelectedAddress(address);
    // Selecting a new asset replaces the trail — selecting from the
    // asset list is a "fresh start", not a pivot.
    setTrail([{ kind: "asset", address }]);
  }, []);

  const onPivot = useCallback(
    (step: PivotStep) => {
      // In Tier 2 mode, clicking a server-filtered dimension issues a
      // fresh fetch alongside the breadcrumb update so the next render
      // can splice the expanded events into the panel. Tier 1 clicks
      // (and Tier 2 client-intersection dimensions) are local-only.
      if (
        scope === "tier2" &&
        step.kind === "dimension" &&
        isTier2ServerDimension(step.dimension)
      ) {
        tier2.startFetch(step.dimension, step.value.key);
      }
      setTrail((current) => appendPivotStep(current, step));
    },
    [scope, tier2],
  );

  const onCrumb = useCallback((indexInclusive: number) => {
    setTrail((current) => backtrackPivotTrail(current, indexInclusive));
  }, []);

  // ── URL hash restore (client-only — Server Components cannot read
  // location.hash) ──
  const hashRestoreAttempted = useRef(false);
  const [staleHashFallback, setStaleHashFallback] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: restore runs once after the corpus is in hand
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (hashRestoreAttempted.current) return;
    hashRestoreAttempted.current = true;
    const parsed = parseTriagePivotHash(window.location.hash);
    if (parsed.mode !== null) {
      onScopeRestoredFromHash?.(parsed.mode === "tier2" ? "tier2" : "tier1");
    }
    if (parsed.asset === null && parsed.steps.length === 0) return;
    // Resolve the asset against the freshly-loaded corpus.
    const restoredAsset =
      parsed.asset !== null
        ? (result.assets.find((a) => a.address === parsed.asset)?.address ??
          null)
        : null;
    if (parsed.asset !== null && restoredAsset === null) {
      setStaleHashFallback(true);
      return;
    }
    if (restoredAsset === null) return;
    const restoredTrail: PivotStep[] = [
      { kind: "asset", address: restoredAsset },
    ];
    let stale = false;
    for (const step of parsed.steps) {
      let label = step.valueKey;
      try {
        // Walk the corpus once for the dimension's events sharing
        // this valueKey so the breadcrumb's display label matches
        // what the panel would show today. Falls back to the raw
        // valueKey when the dimension's value isn't reachable.
        const dim = getPivotDimension(step.dimension);
        for (const ev of result.events) {
          const values = dim.extract(ev);
          const hit = values.find((v) => v.key === step.valueKey);
          if (hit) {
            label = hit.label;
            break;
          }
        }
      } catch {
        stale = true;
        break;
      }
      restoredTrail.push({
        kind: "dimension",
        dimension: step.dimension,
        value: { key: step.valueKey, label },
      });
    }
    if (stale) {
      setStaleHashFallback(true);
      return;
    }
    setSelectedAddress(restoredAsset);
    setTrail(restoredTrail);
  }, [result.assets, result.events]);

  // ── URL hash sync (write-side) ──
  // Persist the breadcrumb + scope into the URL hash whenever they
  // change. Foreign hash keys (#471 strictness) are preserved.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hashState = pivotHashFromTrail(trail, scopeToHashMode(scope));
    const next = replaceTriagePivotHash(window.location.hash, hashState);
    const target = next.length > 0 ? `#${next}` : "";
    if (target === window.location.hash) return;
    // Use replaceState so each pivot click does not push a new
    // history entry — the breadcrumb already supports backtrack.
    const url = `${window.location.pathname}${window.location.search}${target}`;
    window.history.replaceState(null, "", url);
  }, [trail, scope]);

  return (
    <div className="space-y-6">
      {staleHashFallback ? (
        <p
          role="status"
          className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200"
        >
          {labels.staleHashFallback}
        </p>
      ) : null}
      <Tier2EvictionNotice
        evictions={tier2.evictions}
        onDismiss={tier2.acknowledgeEviction}
        labels={labels.tier2Eviction}
      />
      <Tier2ErrorNotice
        errors={tier2.errors}
        onDismiss={tier2.acknowledgeError}
        labels={labels.tier2Error}
      />
      <Tier2PrefetchModal
        open={tier2.pending !== null}
        projectedCount={tier2.pending?.totalCount ?? null}
        threshold={TIER2_PREFETCH_MODAL_THRESHOLD}
        onConfirm={tier2.confirmFetch}
        onCancel={tier2.cancelFetch}
        labels={labels.tier2Modal}
      />
      <TriageFunnelView funnel={result.funnel} labels={labels.funnel} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <TriageAssetListView
          assets={result.assets}
          selectedAddress={effectiveSelection}
          onSelect={onSelectAsset}
          labels={labels.assetList}
        />
        <TriageAssetDetailView
          asset={detailAsset}
          isPivotFocus={pivotFocusAsset !== null}
          labels={labels.assetDetail}
        />
      </div>
      {trail.length > 0 ? (
        <div className="space-y-3">
          <TriagePivotBreadcrumb
            trail={trail}
            onSelect={(idx) => {
              if (idx === 0) {
                setTrail((current) => clearPivotTrail(current));
              } else {
                onCrumb(idx);
              }
            }}
            labels={labels.pivotBreadcrumb}
          />
          <TriagePivotPanel
            sections={sections}
            truncated={result.truncated}
            hasFocus={focusEvents.length > 0}
            onPivot={onPivot}
            labels={labels.pivotPanel}
            isWeakSignal={
              scope === "tier2"
                ? (event) => !tier2.isInTier1Corpus(event)
                : undefined
            }
            deferredSensorDimension={sensorDeferredInTier2}
          />
        </div>
      ) : null}
    </div>
  );
}
