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
        // Tier 2 fetch results are flat `TriageEvent[]` from the
        // Policy fetch service and do not carry a per-tenant marker.
        // In Baseline mode the operator focuses one asset at a time,
        // so attribute Tier 2-spliced events to the trail's asset
        // crumb. The pivot index filters on `(customerId, origAddr)`
        // for the asset step, which is the only consumer of this
        // marker.
        const assetCrumbCustomerId =
          trail.length > 0 && trail[0].kind === "asset"
            ? trail[0].customerId
            : 0;
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
    if (expandedTier2Events.length === 0) return result.events;
    return [...result.events, ...expandedTier2Events];
  }, [result.events, expandedTier2Events]);

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
      const cached = tier2.getCached(
        activeStep.dimension,
        activeStep.value.key,
      );
      if (!cached) return [];
      // Tier 2 fetch results lack a per-tenant marker; attribute them
      // to the trail's asset crumb so the synthesized pivot-focus row
      // can still identify the customer (see `expandedTier2Events`).
      const assetCrumbCustomerId =
        trail.length > 0 && trail[0].kind === "asset" ? trail[0].customerId : 0;
      return cached.events.map((ev) => ({
        ...ev,
        score: baselineScore(ev),
        customerId: assetCrumbCustomerId,
      }));
    }
    return resolveStepFocusEvents(activeStep, expandedEvents, pivotIndex);
  }, [activeStep, expandedEvents, pivotIndex, tier2, trail]);

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
    const isReadyStaticTier2 =
      isStaticTier2Dimension(activeStep.dimension) &&
      tier2.getCached(activeStep.dimension, activeStep.value.key)?.status ===
        "ready";
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
    return {
      // Synthetic asset row — `customerId` defaults to the asset crumb's
      // customer; if the trail has no asset crumb (rare), use 0. The
      // pivot focus card does not key off `customerId`, so the value
      // is purely structural.
      customerId: assetCrumb?.customerId ?? 0,
      customerName:
        focusedAsset?.customerName ?? String(assetCrumb?.customerId ?? 0),
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
  ]);

  const detailAsset = pivotFocusAsset ?? effectiveAsset;

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
    if (scope !== "tier2") {
      return allSections.filter((s) => !isTier2Only(s.dimension));
    }
    return allSections;
  }, [allSections, scope]);

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
    for (const step of trail) {
      if (step.kind !== "dimension") continue;
      if (!isTier2ServerDimension(step.dimension)) continue;
      const cached = tier2.getCached(step.dimension, step.value.key);
      if (cached?.truncated === true) return true;
    }
    return false;
  }, [result.truncated, scope, trail, tier2]);

  const onSelectAsset = useCallback(
    (focus: { customerId: number; address: string }) => {
      setSelected(focus);
      // Selecting a new asset replaces the trail — selecting from the
      // asset list is a "fresh start", not a pivot.
      setTrail([
        {
          kind: "asset",
          customerId: focus.customerId,
          address: focus.address,
        },
      ]);
    },
    [],
  );

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
    },
    [effectiveSelection, scope, tier2, trail],
  );

  const onCrumb = useCallback((indexInclusive: number) => {
    setTrail((current) => backtrackPivotTrail(current, indexInclusive));
  }, []);

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: restore runs once after the corpus is in hand
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (hashRestoreAttempted.current) return;
    hashRestoreAttempted.current = true;
    const parsed = parseTriagePivotHash(window.location.hash);
    if (parsed.mode !== null) {
      onScopeRestoredFromHash?.(parsed.mode === "tier2" ? "tier2" : "tier1");
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
      if (hadRejectedSteps) setStaleHashFallback(true);
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
        setStaleHashFallback(true);
        return;
      }
      const found = result.assets.find(
        (a) =>
          a.customerId === parsed.asset?.customerId &&
          a.address === parsed.asset?.address,
      );
      if (!found) {
        setStaleHashFallback(true);
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
      setStaleHashFallback(true);
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
      setStaleHashFallback(true);
      return;
    }
    setSelected(restoredAsset);
    setTrail(restoredTrail);
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
    for (const { dimension, valueKey } of validations) {
      let dim: ReturnType<typeof getPivotDimension>;
      try {
        dim = getPivotDimension(dimension);
      } catch {
        // Dimension was removed since the URL was produced — stale.
        setSelected(initialFocus);
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
        setStaleHashFallback(true);
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
        setSelected(initialFocus);
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
        setStaleHashFallback(true);
        return;
      }
    }
  }, [
    scope,
    tier2.pending,
    tier2.inFlight,
    tier2.errors,
    expandedEvents,
    initialFocus,
  ]);

  // Tier 2 `sameSensor` pivots that cannot complete against the
  // asset's customer scope (name-unresolved or scope-forbidden, see
  // #502) revert the trail to the asset root and surface the same
  // stale-hash toast as a missing-step restore. Without this, a
  // panel click on a sensor whose name no longer maps would leave
  // the breadcrumb pointing at an unreachable pivot and the operator
  // staring at an empty pivot focus.
  useEffect(() => {
    if (tier2.sensorFallbacks.length === 0) return;
    const fallback = tier2.sensorFallbacks[0];
    setTrail((current) => {
      // Trim back to the first asset crumb so the failed sensor step
      // (and anything past it) is removed. If the trail is empty
      // somehow, leave it alone — defensive only.
      const assetCrumbIndex = current.findIndex((s) => s.kind === "asset");
      if (assetCrumbIndex < 0) return current;
      return current.slice(0, assetCrumbIndex + 1);
    });
    setStaleHashFallback(true);
    tier2.acknowledgeSensorFallback(fallback.sensorName);
  }, [tier2]);

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
        approximateMinimum={tier2.pending?.approximateMinimum ?? null}
        threshold={TIER2_PREFETCH_MODAL_THRESHOLD}
        onConfirm={tier2.confirmFetch}
        onCancel={tier2.cancelFetch}
        labels={labels.tier2Modal}
      />
      <TriageFunnelView funnel={result.funnel} labels={labels.funnel} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <TriageAssetListView
          assets={result.assets}
          selected={effectiveSelection}
          observedDenominatorTruncated={result.observedDenominatorTruncated}
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
            showLearningMethodSection={scope === "tier2"}
            showKeywordsSection={scope === "tier2"}
            recentKeywords={recentKeywords}
            onSubmitKeyword={onSubmitKeyword}
          />
        </div>
      ) : null}
    </div>
  );
}
