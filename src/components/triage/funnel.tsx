"use client";

import type { TriageFunnel } from "@/lib/triage";

export interface TriageFunnelLabels {
  title: string;
  detected: string;
  triaged: string;
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
      className="rounded-md border bg-card p-4 shadow-xs"
    >
      <h2
        id="triage-funnel-heading"
        className="text-sm font-semibold text-muted-foreground"
      >
        {labels.title}
      </h2>
      <dl className="mt-3 grid gap-4 sm:grid-cols-3">
        <Stat
          label={labels.detected}
          value={COUNT_FORMAT.format(funnel.detected)}
        />
        <Stat
          label={labels.triaged}
          value={COUNT_FORMAT.format(funnel.triaged)}
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
