"use client";

import { panelSurface } from "@/components/ui/panel-surface";
import type { TriageFunnel } from "@/lib/triage";
import { cn } from "@/lib/utils";

export interface TriageFunnelLabels {
  title: string;
  detected: string;
  /** Tooltip explaining the slider-independent "Triaged" count (#471 §4). */
  triagedHint?: string;
  triaged: string;
  /**
   * "Shown" segment (#471 §4) — the post-quota, post-merge-cap union
   * size that actually reaches the screen and moves with the slider.
   */
  shown: string;
  /** Tooltip explaining the slider relationship for "Shown" (#471 §4). */
  shownHint?: string;
  passThrough: string;
  passThroughHint: string;
}

interface TriageFunnelViewProps {
  funnel: TriageFunnel;
  labels: TriageFunnelLabels;
}

const PERCENT_FORMAT = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
});

const COUNT_FORMAT = new Intl.NumberFormat();

export function TriageFunnelView({ funnel, labels }: TriageFunnelViewProps) {
  return (
    <section
      aria-labelledby="triage-funnel-heading"
      className={cn(panelSurface, "p-4")}
    >
      <h2
        id="triage-funnel-heading"
        className="text-sm font-semibold text-muted-foreground"
      >
        {labels.title}
      </h2>
      <dl className="mt-3 grid gap-4 sm:grid-cols-4">
        <Stat
          label={labels.detected}
          value={COUNT_FORMAT.format(funnel.detected)}
        />
        <Stat
          label={labels.triaged}
          value={COUNT_FORMAT.format(funnel.triaged)}
          hint={labels.triagedHint}
        />
        <Stat
          label={labels.shown}
          value={COUNT_FORMAT.format(funnel.shown)}
          hint={labels.shownHint}
        />
        <Stat
          label={labels.passThrough}
          value={PERCENT_FORMAT.format(funnel.passThroughRate)}
          hint={labels.passThroughHint}
        />
      </dl>
    </section>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="text-2xl font-bold text-foreground">{value}</dd>
      {hint ? (
        <span className="text-xs text-muted-foreground">{hint}</span>
      ) : null}
    </div>
  );
}
