"use client";

import { useTimezone } from "@/components/providers/timezone-provider";
import { formatDateTime } from "@/lib/format-date";
import type { TriageAsset } from "@/lib/triage";
import {
  type ProtectedByStoryMarkerLabels,
  renderProtectedByStoryMarker,
} from "./event-row/protected-by-story-marker";
import {
  type TriageEventRow,
  TriageEventTable,
  type TriageEventTableLabels,
} from "./event-row/triage-event-table";

export interface TriageAssetDetailLabels {
  title: string;
  /**
   * Header title used when the panel reflects a pivot focus instead
   * of an asset address. The breadcrumb above tells the operator how
   * they got here; this just makes the card honest about what its
   * row currently means (a JA3 / SNI / etc. value, not an IP).
   */
  pivotFocusTitle: string;
  /**
   * Aria/label prefix for the customer name line in the asset detail
   * header. Required for multi-customer scopes so two tenants sharing
   * the same RFC1918 address remain distinguishable after selection.
   */
  customerLabel: string;
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
  /**
   * Story-protected row marker copy (#471 §3). Parameterized by
   * `{score}`; rendered as both `aria-label` and hover tooltip.
   */
  protectedByStoryMarker: ProtectedByStoryMarkerLabels;
}

interface TriageAssetDetailViewProps {
  asset: TriageAsset | null;
  /**
   * When `true` the header is rendered with `labels.pivotFocusTitle`
   * and the address line is shown as a label rather than a mono-IP.
   * Set by `baseline-content.tsx` whenever the active breadcrumb
   * step is a non-asset dimension pivot.
   */
  isPivotFocus?: boolean;
  labels: TriageAssetDetailLabels;
}

const SCORE_FORMAT = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
});
const COUNT_FORMAT = new Intl.NumberFormat();

export function TriageAssetDetailView({
  asset,
  isPivotFocus = false,
  labels,
}: TriageAssetDetailViewProps) {
  const timezone = useTimezone();
  const headerTitle = isPivotFocus ? labels.pivotFocusTitle : labels.title;
  const tableLabels: TriageEventTableLabels = {
    timeColumn: labels.timeColumn,
    kindColumn: labels.kindColumn,
    categoryColumn: labels.categoryColumn,
    scoreColumn: labels.scoreColumn,
  };
  const rows: ReadonlyArray<TriageEventRow> = asset
    ? asset.events.map((event) => ({
        key: event.rowKey ?? `${event.time}-${event.__typename}`,
        time: formatDateTime(event.time, timezone),
        kind: event.__typename,
        category: event.category ?? null,
        baselineScore: event.score,
        protectedByStory:
          event.protectedByStory === true ? { score: event.score } : undefined,
      }))
    : [];

  if (!asset) {
    return (
      <section className="rounded-md bg-card p-4">
        <h2 className="text-sm font-semibold text-muted-foreground">
          {headerTitle}
        </h2>
        <p className="mt-3 text-sm text-muted-foreground">
          {labels.emptySelection}
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label={headerTitle}
      className="flex flex-col gap-4 rounded-md bg-card p-4"
    >
      <header className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-muted-foreground">
          {headerTitle}
        </h2>
        <p
          className={
            isPivotFocus
              ? "text-lg text-foreground"
              : "font-mono text-lg text-foreground"
          }
        >
          {asset.address}
        </p>
        <p className="text-xs text-muted-foreground">
          <span className="font-medium">{labels.customerLabel}:</span>{" "}
          {asset.customerName}
        </p>
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
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{labels.emptyEvents}</p>
        ) : (
          <TriageEventTable
            rows={rows}
            labels={tableLabels}
            renderProtectedByStoryMarker={renderProtectedByStoryMarker(
              labels.protectedByStoryMarker,
            )}
          />
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
