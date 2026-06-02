"use client";

import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { panelSurface } from "@/components/ui/panel-surface";
import {
  presetTriagePeriod,
  TRIAGE_MAX_DURATION_MS,
  TRIAGE_MAX_LOOKBACK_MS,
  TRIAGE_PERIOD_PRESETS,
  type TriagePeriod,
} from "@/lib/triage";
import { cn } from "@/lib/utils";

export interface TriagePeriodPickerLabels {
  legend: string;
  startLabel: string;
  endLabel: string;
  apply: string;
  invalidRange: string;
  durationCapHint: string;
  lookbackHint: string;
  /** Legend for the quick-range chip group. */
  presetsLegend: string;
  /** Per-preset chip labels, keyed by {@link TRIAGE_PERIOD_PRESETS} key. */
  presets: Record<string, string>;
}

interface TriagePeriodPickerProps {
  period: TriagePeriod;
  onApply: (period: TriagePeriod) => void;
  pending: boolean;
  labels: TriagePeriodPickerLabels;
  /**
   * Increments whenever the parent rejects a draft submission (e.g.
   * the operator cancelled the period-change confirmation modal). The
   * picker resets its draft inputs back to `period` so the visible
   * Start / End fields stay in sync with the loaded period.
   */
  draftResetSignal?: number;
}

/**
 * Format an ISO-8601 timestamp for `<input type="datetime-local">`,
 * which expects `YYYY-MM-DDTHH:MM` in the browser's local timezone.
 * The conversion is lossy (drops seconds + milliseconds) but the
 * Triage period selector operates at minute granularity, so the loss
 * is intentional.
 */
function isoToLocalInput(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function localInputToIso(local: string): string | null {
  if (!local) return null;
  const ms = Date.parse(local);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

export function TriagePeriodPicker({
  period,
  onApply,
  pending,
  labels,
  draftResetSignal,
}: TriagePeriodPickerProps) {
  const startId = useId();
  const endId = useId();
  const [startLocal, setStartLocal] = useState(() =>
    isoToLocalInput(period.startIso),
  );
  const [endLocal, setEndLocal] = useState(() =>
    isoToLocalInput(period.endIso),
  );
  const [error, setError] = useState<string | null>(null);

  // Resync the inputs when the parent reports a different period
  // (e.g., after a clamp on submit) or when the parent rejects the
  // current draft (cancel of the period-change confirmation modal).
  // biome-ignore lint/correctness/useExhaustiveDependencies: draftResetSignal is the trigger
  useEffect(() => {
    setStartLocal(isoToLocalInput(period.startIso));
    setEndLocal(isoToLocalInput(period.endIso));
    setError(null);
  }, [period.endIso, period.startIso, draftResetSignal]);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const startIso = localInputToIso(startLocal);
    const endIso = localInputToIso(endLocal);
    if (!startIso || !endIso) {
      setError(labels.invalidRange);
      return;
    }
    const startMs = Date.parse(startIso);
    const endMs = Date.parse(endIso);
    if (endMs <= startMs) {
      setError(labels.invalidRange);
      return;
    }
    if (endMs - startMs > TRIAGE_MAX_DURATION_MS) {
      setError(labels.durationCapHint);
      return;
    }
    if (Date.now() - startMs > TRIAGE_MAX_LOOKBACK_MS) {
      setError(labels.lookbackHint);
      return;
    }
    setError(null);
    onApply({ startIso, endIso });
  }

  // Quick-range chip: fill the start/end drafts so the visible inputs
  // stay in sync, then apply immediately. `onApply` routes through the
  // parent's pivot-confirm modal / clamp / `draftResetSignal` flow just
  // like a manual submit, so no separate validation is needed here —
  // every preset is bounded by `TRIAGE_MAX_DURATION_MS` by construction.
  function handlePreset(durationMs: number) {
    const period = presetTriagePeriod(durationMs);
    setStartLocal(isoToLocalInput(period.startIso));
    setEndLocal(isoToLocalInput(period.endIso));
    setError(null);
    onApply(period);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={cn("flex flex-wrap items-end gap-3", panelSurface, "p-3")}
      aria-label={labels.legend}
    >
      <div className="flex flex-col gap-1">
        <label
          htmlFor={startId}
          className="text-xs font-medium text-muted-foreground"
        >
          {labels.startLabel}
        </label>
        <input
          id={startId}
          type="datetime-local"
          value={startLocal}
          onChange={(e) => setStartLocal(e.target.value)}
          className="rounded-md border bg-background px-2 py-1 text-sm"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label
          htmlFor={endId}
          className="text-xs font-medium text-muted-foreground"
        >
          {labels.endLabel}
        </label>
        <input
          id={endId}
          type="datetime-local"
          value={endLocal}
          onChange={(e) => setEndLocal(e.target.value)}
          className="rounded-md border bg-background px-2 py-1 text-sm"
        />
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        {labels.apply}
      </Button>
      <fieldset className="flex basis-full flex-wrap items-center gap-2">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">
          {labels.presetsLegend}
        </legend>
        {TRIAGE_PERIOD_PRESETS.map((preset) => (
          <Button
            key={preset.key}
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => handlePreset(preset.durationMs)}
          >
            {labels.presets[preset.key]}
          </Button>
        ))}
      </fieldset>
      {error ? (
        <p
          role="alert"
          className="basis-full text-xs font-medium text-destructive"
        >
          {error}
        </p>
      ) : null}
    </form>
  );
}
