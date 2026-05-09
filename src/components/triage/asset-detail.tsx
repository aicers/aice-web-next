"use client";

import { useTimezone } from "@/components/providers/timezone-provider";
import { formatDateTime } from "@/lib/format-date";
import { baselineScore, type TriageAsset } from "@/lib/triage";

export interface TriageAssetDetailLabels {
  title: string;
  emptySelection: string;
  emptyEvents: string;
  scoreLabel: string;
  triagedLabel: string;
  detectedLabel: string;
  eventsHeading: string;
  timeColumn: string;
  kindColumn: string;
  categoryColumn: string;
  scoreColumn: string;
}

interface TriageAssetDetailViewProps {
  asset: TriageAsset | null;
  labels: TriageAssetDetailLabels;
}

const SCORE_FORMAT = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
});
const COUNT_FORMAT = new Intl.NumberFormat();

export function TriageAssetDetailView({
  asset,
  labels,
}: TriageAssetDetailViewProps) {
  const timezone = useTimezone();

  if (!asset) {
    return (
      <section className="rounded-md border bg-card p-4 shadow-xs">
        <h2 className="text-sm font-semibold text-muted-foreground">
          {labels.title}
        </h2>
        <p className="mt-3 text-sm text-muted-foreground">
          {labels.emptySelection}
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label={labels.title}
      className="flex flex-col gap-4 rounded-md border bg-card p-4 shadow-xs"
    >
      <header className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-muted-foreground">
          {labels.title}
        </h2>
        <p className="font-mono text-lg text-foreground">{asset.address}</p>
      </header>
      <dl className="grid grid-cols-3 gap-3 text-sm">
        <Stat
          label={labels.scoreLabel}
          value={SCORE_FORMAT.format(asset.score)}
        />
        <Stat
          label={labels.triagedLabel}
          value={COUNT_FORMAT.format(asset.triagedCount)}
        />
        <Stat
          label={labels.detectedLabel}
          value={COUNT_FORMAT.format(asset.detectedCount)}
        />
      </dl>
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {labels.eventsHeading}
        </h3>
        {asset.events.length === 0 ? (
          <p className="text-sm text-muted-foreground">{labels.emptyEvents}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted-foreground">
              <tr className="border-b">
                <th scope="col" className="py-2 pr-2 text-left font-medium">
                  {labels.timeColumn}
                </th>
                <th scope="col" className="py-2 pr-2 text-left font-medium">
                  {labels.kindColumn}
                </th>
                <th scope="col" className="py-2 pr-2 text-left font-medium">
                  {labels.categoryColumn}
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  {labels.scoreColumn}
                </th>
              </tr>
            </thead>
            <tbody>
              {asset.events.map((event) => (
                <tr
                  key={event.rowKey ?? `${event.time}-${event.__typename}`}
                  className="border-b last:border-0"
                >
                  <td className="py-1.5 pr-2 font-mono text-xs">
                    {formatDateTime(event.time, timezone)}
                  </td>
                  <td className="py-1.5 pr-2">{event.__typename}</td>
                  <td className="py-1.5 pr-2 text-muted-foreground">
                    {event.category ?? "—"}
                  </td>
                  <td className="py-1.5 text-right font-mono">
                    {SCORE_FORMAT.format(baselineScore(event))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="text-base font-semibold text-foreground">{value}</dd>
    </div>
  );
}
