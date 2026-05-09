"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

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
  type TriageMode,
  TriageModeToggle,
  type TriageModeToggleLabels,
} from "./mode-toggle";
import {
  TriagePeriodPicker,
  type TriagePeriodPickerLabels,
} from "./period-picker";

export interface TriageShellLabels {
  title: string;
  intro: string;
  periodPicker: TriagePeriodPickerLabels;
  modeToggle: TriageModeToggleLabels;
  errorBanner: string;
  forbiddenBanner: string;
  forbiddenScopeBanner: string;
  truncatedBannerTemplate: string;
  clampedNotice: string;
  baseline: TriageBaselineLabels;
}

export type TriageShellState =
  | { status: "ok"; result: TriageLoadResult }
  | { status: "error"; kind: "forbidden" | "forbidden-scope" | "unknown" };

interface TriageShellProps {
  initialPeriod: TriagePeriod;
  initialState: TriageShellState;
  initialClamped: boolean;
  labels: TriageShellLabels;
}

const COUNT_FORMAT = new Intl.NumberFormat();

export function TriageShell({
  initialPeriod,
  initialState,
  initialClamped,
  labels,
}: TriageShellProps) {
  const router = useRouter();
  const [period, setPeriod] = useState<TriagePeriod>(initialPeriod);
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<TriageMode>("baseline");

  // Resync local state to the server-resolved period whenever the
  // page rerenders with a new `initialPeriod`. The server clamps
  // out-of-range URL params (`parseTriagePeriod`), so without this
  // the picker can keep displaying the operator's submitted range
  // while the funnel/asset list reflect the clamped range — the
  // visible period would no longer match the aggregated period.
  useEffect(() => {
    setPeriod(initialPeriod);
  }, [initialPeriod]);

  function applyPeriod(next: TriagePeriod) {
    setPeriod(next);
    const params = new URLSearchParams();
    params.set("start", next.startIso);
    params.set("end", next.endIso);
    startTransition(() => {
      // Push the new range to the URL so the server component
      // re-renders with a fresh slice. The server clamps + reloads,
      // and the useEffect above syncs the picker back to the
      // clamped range.
      router.replace(`?${params.toString()}`, { scroll: false });
    });
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-foreground text-2xl font-bold">{labels.title}</h1>
        <p className="text-sm text-muted-foreground">{labels.intro}</p>
      </header>
      <div className="flex flex-wrap items-end gap-4">
        <TriagePeriodPicker
          period={period}
          onApply={applyPeriod}
          pending={pending}
          labels={labels.periodPicker}
        />
        <TriageModeToggle
          mode={mode}
          onChange={setMode}
          labels={labels.modeToggle}
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
            labels={labels.baseline}
          />
        ) : null
      ) : null}
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
  if (state.result.truncated) {
    const banner = labels.truncatedBannerTemplate
      .replace("{loaded}", COUNT_FORMAT.format(state.result.loadedEventCount))
      .replace("{cap}", COUNT_FORMAT.format(TRIAGE_HARD_EVENT_CAP));
    return (
      <p
        role="status"
        className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200"
      >
        {banner}
      </p>
    );
  }
  return null;
}
