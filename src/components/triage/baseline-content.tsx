"use client";

/**
 * Baseline-mode body of the Triage page. Phase 1.A — discussion #447
 * §6 deprecatable seam: this subtree must NOT import any policy
 * module so removing the mode toggle reduces the page to baseline-
 * only with a one-line edit. The funnel/asset-list/asset-detail/
 * pivot primitives, the scoring rule, and this file are all the
 * policy-free baseline tree.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  ScoredTriageEvent,
  TriageAsset,
  TriageLoadResult,
} from "@/lib/triage";
import {
  appendPivotStep,
  backtrackPivotTrail,
  buildPivotPanel,
  clearPivotTrail,
  hasPivotedAwayFromAsset,
  type PivotStep,
  pivotIndexFor,
  resolveStepFocusEvents,
} from "@/lib/triage/pivot";

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

export interface TriageBaselineLabels {
  funnel: TriageFunnelLabels;
  assetList: TriageAssetListLabels;
  assetDetail: TriageAssetDetailLabels;
  pivotPanel: TriagePivotPanelLabels;
  pivotBreadcrumb: TriagePivotBreadcrumbLabels;
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

export function TriageBaselineContent({
  result,
  resetSignal,
  onPivotTrailChange,
  labels,
}: TriageBaselineContentProps) {
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

  const pivotIndex = useMemo(
    () => pivotIndexFor(result.events),
    [result.events],
  );

  const activeStep = trail.length > 0 ? trail[trail.length - 1] : null;
  const focusEvents: ScoredTriageEvent[] = useMemo(() => {
    if (!activeStep) return [];
    return resolveStepFocusEvents(activeStep, result.events, pivotIndex);
  }, [activeStep, result.events, pivotIndex]);

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

  const sections = useMemo(
    () => buildPivotPanel(pivotIndex, focusEvents),
    [pivotIndex, focusEvents],
  );

  const onSelectAsset = useCallback((address: string) => {
    setSelectedAddress(address);
    // Selecting a new asset replaces the trail — selecting from the
    // asset list is a "fresh start", not a pivot.
    setTrail([{ kind: "asset", address }]);
  }, []);

  const onPivot = useCallback((step: PivotStep) => {
    setTrail((current) => appendPivotStep(current, step));
  }, []);

  const onCrumb = useCallback((indexInclusive: number) => {
    setTrail((current) => backtrackPivotTrail(current, indexInclusive));
  }, []);

  return (
    <div className="space-y-6">
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
          />
        </div>
      ) : null}
    </div>
  );
}
