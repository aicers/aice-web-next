"use client";

import { useRouter } from "next/navigation";
import type React from "react";
import { useEffect, useRef, useState, useTransition } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  TRIAGE_HARD_EVENT_CAP,
  type TriageLoadResult,
  type TriagePeriod,
} from "@/lib/triage";

import {
  TriageBaselineContent,
  type TriageBaselineLabels,
} from "./baseline-content";
import {
  TriageFreshnessHeader,
  type TriageFreshnessHeaderLabels,
} from "./freshness-header";
import {
  type TriageMode,
  TriageModeToggle,
  type TriageModeToggleLabels,
} from "./mode-toggle";
import {
  TriagePeriodPicker,
  type TriagePeriodPickerLabels,
} from "./period-picker";
import {
  type TriagePivotScope,
  TriagePivotScopeToggle,
  type TriagePivotScopeToggleLabels,
} from "./scope-toggle";

export interface TriageShellLabels {
  title: string;
  intro: string;
  periodPicker: TriagePeriodPickerLabels;
  modeToggle: TriageModeToggleLabels;
  scopeToggle: TriagePivotScopeToggleLabels;
  errorBanner: string;
  forbiddenBanner: string;
  forbiddenScopeBanner: string;
  truncatedBannerTemplate: string;
  clampedNotice: string;
  /**
   * Funnel-level "Detected over last 30d" affordance (1B-3 / #458).
   * Surfaces whenever {@link TriageLoadResult.observedDenominatorTruncated}
   * is `true` — the selected window's earliest moment is older than
   * 30 days ago, so the funnel's denominator covers only the in-
   * retention slice.
   */
  observedDenominatorTruncatedNotice: string;
  freshness: TriageFreshnessHeaderLabels;
  baseline: TriageBaselineLabels;
  periodChangeConfirm: {
    title: string;
    description: string;
    confirm: string;
    cancel: string;
  };
}

export type TriageShellState =
  | { status: "ok"; result: TriageLoadResult }
  | { status: "error"; kind: "forbidden" | "forbidden-scope" | "unknown" };

interface TriageShellProps {
  initialPeriod: TriagePeriod;
  initialState: TriageShellState;
  initialClamped: boolean;
  /**
   * Stable identifier for the customer scope; gates Tier 2 cache reuse
   * across tenant switches in the same browser session. Computed
   * server-side in the page so the client never derives it from
   * potentially-stale state.
   */
  customerScope?: string;
  labels: TriageShellLabels;
}

const COUNT_FORMAT = new Intl.NumberFormat();

export function TriageShell({
  initialPeriod,
  initialState,
  initialClamped,
  customerScope,
  labels,
}: TriageShellProps) {
  const router = useRouter();
  const [period, setPeriod] = useState<TriagePeriod>(initialPeriod);
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<TriageMode>("baseline");
  // Tier 1 / Tier 2 pivot scope. Default Tier 1 on every fresh menu
  // entry per #453 — sticky across sessions risks an analyst
  // returning to a 5,000-row fetch they did not intend. URL-hash
  // persistence (set up in baseline-content) covers the share/reload
  // case.
  const [scope, setScope] = useState<TriagePivotScope>("tier1");
  // Bumped whenever a period change is committed; baseline-content
  // resets its breadcrumb on this signal. Kept here (not in the
  // component) so the period-change confirmation modal lives in the
  // same component as the period picker.
  const [resetSignal, setResetSignal] = useState(0);
  const pendingPeriodRef = useRef<TriagePeriod | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Bumped when the operator cancels the period-change confirmation
  // so the picker resets its draft inputs back to the loaded period —
  // otherwise the rejected Start / End values would linger in the
  // controls while the corpus and breadcrumb stay on the old period.
  const [pickerResetSignal, setPickerResetSignal] = useState(0);
  // Tracks whether the user has pivoted away from the asset root.
  // Bubbled up via a callback from baseline-content so the shell can
  // decide whether to surface the confirmation modal.
  const hasPivotsRef = useRef(false);

  // Resync local state to the server-resolved period whenever the
  // page rerenders with a new `initialPeriod`. The server clamps
  // out-of-range URL params (`parseTriagePeriod`), so without this
  // the picker can keep displaying the operator's submitted range
  // while the funnel/asset list reflect the clamped range — the
  // visible period would no longer match the aggregated period.
  useEffect(() => {
    setPeriod(initialPeriod);
  }, [initialPeriod]);

  function commitPeriod(next: TriagePeriod) {
    setPeriod(next);
    const params = new URLSearchParams();
    params.set("start", next.startIso);
    params.set("end", next.endIso);
    setResetSignal((s) => s + 1);
    hasPivotsRef.current = false;
    startTransition(() => {
      router.replace(`?${params.toString()}`, { scroll: false });
    });
  }

  function applyPeriod(next: TriagePeriod) {
    if (hasPivotsRef.current) {
      pendingPeriodRef.current = next;
      setConfirmOpen(true);
      return;
    }
    commitPeriod(next);
  }

  function onConfirmPeriodChange() {
    const next = pendingPeriodRef.current;
    pendingPeriodRef.current = null;
    setConfirmOpen(false);
    if (next) commitPeriod(next);
  }

  function onCancelPeriodChange() {
    pendingPeriodRef.current = null;
    setConfirmOpen(false);
    setPickerResetSignal((s) => s + 1);
  }

  // Route all close paths through the cancel cleanup so non-button
  // dismissals (Escape, programmatic close) reset the picker draft and
  // clear `pendingPeriodRef`, matching the explicit Cancel button. The
  // Confirm button consumes `pendingPeriodRef` first, so when its
  // intrinsic close fires here the ref is already null and we just
  // sync the open state.
  function onConfirmDialogOpenChange(open: boolean) {
    if (open) {
      setConfirmOpen(true);
      return;
    }
    if (pendingPeriodRef.current !== null) {
      onCancelPeriodChange();
    } else {
      setConfirmOpen(false);
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-foreground text-2xl font-bold">{labels.title}</h1>
        <p className="text-sm text-muted-foreground">{labels.intro}</p>
        {initialState.status === "ok" ? (
          <TriageFreshnessHeader
            freshness={initialState.result.freshness}
            labels={labels.freshness}
          />
        ) : null}
      </header>
      <div className="flex flex-wrap items-end gap-4">
        <TriagePeriodPicker
          period={period}
          onApply={applyPeriod}
          pending={pending}
          labels={labels.periodPicker}
          draftResetSignal={pickerResetSignal}
        />
        <TriageModeToggle
          mode={mode}
          onChange={setMode}
          labels={labels.modeToggle}
        />
        <TriagePivotScopeToggle
          scope={scope}
          onChange={setScope}
          labels={labels.scopeToggle}
        />
      </div>
      {initialClamped ? (
        <p className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200">
          {labels.clampedNotice}
        </p>
      ) : null}
      <BannerForState state={initialState} labels={labels} />
      {initialState.status === "ok" ? (
        // Phase 1.A only wires the baseline branch — the mode toggle
        // is the single import point for the future "With my policies"
        // subtree (#447 §6 deprecatable seam). Today the toggle is
        // disabled on `policies`, so `mode` is always `"baseline"`
        // here in practice; keep the explicit guard so the seam is
        // visible at the import boundary.
        mode === "baseline" ? (
          <TriageBaselineContent
            result={initialState.result}
            resetSignal={resetSignal}
            period={period}
            customerScope={customerScope}
            scope={scope}
            onScopeRestoredFromHash={setScope}
            onPivotTrailChange={(hasPivots) => {
              hasPivotsRef.current = hasPivots;
            }}
            labels={labels.baseline}
          />
        ) : null
      ) : null}
      <AlertDialog open={confirmOpen} onOpenChange={onConfirmDialogOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {labels.periodChangeConfirm.title}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {labels.periodChangeConfirm.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {labels.periodChangeConfirm.cancel}
            </AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmPeriodChange}>
              {labels.periodChangeConfirm.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function BannerForState({
  state,
  labels,
}: {
  state: TriageShellState;
  labels: TriageShellLabels;
}) {
  if (state.status === "error") {
    const message =
      state.kind === "forbidden"
        ? labels.forbiddenBanner
        : state.kind === "forbidden-scope"
          ? labels.forbiddenScopeBanner
          : labels.errorBanner;
    return (
      <p
        role="alert"
        className="rounded-md border border-destructive/60 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        {message}
      </p>
    );
  }
  const banners: React.ReactNode[] = [];
  if (state.result.truncated) {
    const banner = labels.truncatedBannerTemplate
      .replace("{loaded}", COUNT_FORMAT.format(state.result.loadedEventCount))
      .replace("{cap}", COUNT_FORMAT.format(TRIAGE_HARD_EVENT_CAP));
    banners.push(
      <p
        key="truncated"
        role="status"
        className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200"
      >
        {banner}
      </p>,
    );
  }
  if (state.result.observedDenominatorTruncated) {
    banners.push(
      <p
        key="observed-truncated"
        role="status"
        className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200"
      >
        {labels.observedDenominatorTruncatedNotice}
      </p>,
    );
  }
  if (banners.length === 0) return null;
  return <>{banners}</>;
}
