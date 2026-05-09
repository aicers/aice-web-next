"use client";

import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  TRIAGE_MAX_DURATION_MS,
  TRIAGE_MAX_LOOKBACK_MS,
  type TriagePeriod,
} from "@/lib/triage";

export interface TriagePeriodPickerLabels {
  legend: string;
  startLabel: string;
  endLabel: string;
  apply: string;
  invalidRange: string;
  durationCapHint: string;
  lookbackHint: string;
}

interface TriagePeriodPickerProps {
  period: TriagePeriod;
  onApply: (period: TriagePeriod) => void;
  pending: boolean;
  labels: TriagePeriodPickerLabels;
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
  // (e.g., after a clamp on submit).
  useEffect(() => {
    setStartLocal(isoToLocalInput(period.startIso));
    setEndLocal(isoToLocalInput(period.endIso));
    setError(null);
  }, [period.endIso, period.startIso]);

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

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-wrap items-end gap-3 rounded-md border bg-card p-3 shadow-xs"
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
