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
import {
  isTier2ServerDimension,
  type Tier2Dimension,
} from "@/lib/triage/tier2-filter";
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
    for (const step of trail) {
      if (step.kind !== "dimension") continue;
      if (!isTier2ServerDimension(step.dimension)) continue;
      const cached = tier2.getCached(step.dimension, step.value.key);
      if (!cached || cached.events.length === 0) continue;
      for (const ev of cached.events) {
        const key = tier2DedupeKey(ev);
        if (corpusKeys.has(key) || seen.has(key)) continue;
        seen.add(key);
        out.push({ ...ev, score: baselineScore(ev) });
      }
    }
    return out;
  }, [scope, trail, tier2, result.events]);

  const expandedEvents: readonly ScoredTriageEvent[] = useMemo(() => {
    if (expandedTier2Events.length === 0) return result.events;
    return [...result.events, ...expandedTier2Events];
  }, [result.events, expandedTier2Events]);

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

  // Tier-2-only dimensions (`kinds`, `categories`, `levels`) are
  // hidden in Tier 1 mode — their click action is a Tier 2 fetch and
  // surfacing them under Tier 1 would let the operator click a row
  // that goes nowhere. They reappear under the "Tier 2 only" group
  // when the toggle is on. In Tier 2 mode the `sameSensor` row is
  // hidden until a `triage:read`-compatible sensor name→ID lookup
  // ships (#453); the panel surfaces a disabled placeholder with the
  // "requires sensor index" tooltip so the operator can see that the
  // row is intentionally absent.
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
    if (scope !== "tier2") {
      return allSections.filter((s) => !isTier2Only(s.dimension));
    }
    return allSections.filter((s) => s.dimension !== "sameSensor");
  }, [allSections, scope]);
  const sensorDeferredInTier2 = useMemo(() => {
    if (scope !== "tier2") return false;
    return allSections.some((s) => s.dimension === "sameSensor");
  }, [allSections, scope]);

  // Surface truncation from both the Tier 1 loader (5,000-event corpus
  // cap, applied to the period) and the active Tier 2 dimension fetch
  // (5,000-event per-dimension cap). Without folding the Tier 2 hit in,
  // a capped server-filtered pivot would silently look complete even
  // though the manual promises a truncation hint when either layer
  // hits its cap. The active Tier 2 step is the one that affects the
  // currently-rendered panel — earlier breadcrumb steps' caches are
  // for the prior focus and do not change the present truncation
  // signal.
  const panelTruncated = useMemo(() => {
    if (result.truncated) return true;
    if (scope !== "tier2") return false;
    if (!activeStep || activeStep.kind !== "dimension") return false;
    if (!isTier2ServerDimension(activeStep.dimension)) return false;
    const cached = tier2.getCached(activeStep.dimension, activeStep.value.key);
    return cached?.truncated === true;
  }, [result.truncated, scope, activeStep, tier2]);

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
  // Server-filtered steps decoded from the hash whose data still has
  // to be fetched after restore. The restore effect parses the hash
  // and seeds the trail, but `useTier2Pivot.startFetch` would no-op if
  // called before the parent's scope prop has flipped to `"tier2"`. A
  // separate effect drains this queue once `scope === "tier2"` is
  // committed, so a shared Tier 2 URL actually re-issues the trail's
  // server fetches (including the pre-fetch modal path when the
  // projection trips the threshold).
  const pendingHashFetchesRef = useRef<
    Array<{ dimension: Tier2Dimension; valueKey: string }>
  >([]);
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
    const refetchQueue: Array<{
      dimension: Tier2Dimension;
      valueKey: string;
    }> = [];
    // Tier 2-only server dimensions are not derivable from the Tier 1
    // corpus, so a hash carrying them cannot be label-resolved here.
    // Treat them as restorable with the raw valueKey as the display
    // label — the confirmed click on Tier 2 refetches anyway. Tier 1
    // / Tier 1-overlapping dimensions must show at least one event in
    // the corpus, otherwise the hash is stale and the breadcrumb
    // falls back to the asset root with a toast.
    for (const step of parsed.steps) {
      let dim: ReturnType<typeof getPivotDimension>;
      try {
        dim = getPivotDimension(step.dimension);
      } catch {
        stale = true;
        break;
      }
      const isTier2Only = dim.tier2Only === true;
      let label = step.valueKey;
      let found = false;
      for (const ev of result.events) {
        const values = dim.extract(ev);
        const hit = values.find((v) => v.key === step.valueKey);
        if (hit) {
          label = hit.label;
          found = true;
          break;
        }
      }
      if (!found && !isTier2Only) {
        stale = true;
        break;
      }
      restoredTrail.push({
        kind: "dimension",
        dimension: step.dimension,
        value: { key: step.valueKey, label },
      });
      // Server-filtered steps need an actual Tier 2 fetch on restore —
      // the breadcrumb alone gives the operator a misleadingly empty
      // panel computed against the Tier 1 corpus only. Queue them now;
      // the second effect dispatches once Tier 2 mode is enabled.
      if (parsed.mode === "tier2" && isTier2ServerDimension(step.dimension)) {
        refetchQueue.push({
          dimension: step.dimension,
          valueKey: step.valueKey,
        });
      }
    }
    if (stale) {
      setStaleHashFallback(true);
      return;
    }
    setSelectedAddress(restoredAsset);
    setTrail(restoredTrail);
    if (refetchQueue.length > 0) {
      pendingHashFetchesRef.current = refetchQueue;
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
      );
      // Still loading (or modal-gated through `pending`, handled
      // above): wait for the next render.
      if (status?.status === "loading") return;
      // Either ready, errored, or cleared via cancel: this slot is
      // free again. Fall through to fire the next queued item.
      draining.current = null;
    }
    if (pendingHashFetchesRef.current.length === 0) return;
    const next = pendingHashFetchesRef.current.shift();
    if (!next) return;
    draining.current = next;
    tier2.startFetch(next.dimension, next.valueKey);
  }, [scope, tier2, tier2.pending, tier2.inFlight, tier2.errors]);

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
            truncated={panelTruncated}
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
