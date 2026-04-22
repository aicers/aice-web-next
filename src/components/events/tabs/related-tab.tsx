"use client";

import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";

import { Link } from "@/i18n/navigation";
import { buildDetectionPivotUrl } from "@/lib/detection/url-filters";
import type { EventLocator } from "@/lib/events/event-locator";
import {
  fetchRelatedPivotSummaries,
  type PivotId,
  type RelatedPivotSummary,
} from "@/lib/events/related-pivots";

export interface RelatedLabels {
  sameSource: string;
  sameDestination: string;
  sameKind: string;
  sameSession: string;
  lastDay: string;
  lastWeek: string;
  openInSearch: string;
  loading: string;
  count: string;
  lastSeen: string;
  none: string;
  note: string;
}

interface Props {
  locator: EventLocator;
  labels: RelatedLabels;
}

interface PivotEntry {
  id: PivotId;
  label: string;
  windowLabel: string;
  href: string;
}

export function RelatedTab({ locator, labels }: Props) {
  const pivots: PivotEntry[] = [
    {
      id: "same-source",
      label: labels.sameSource,
      windowLabel: labels.lastDay,
      href: buildDetectionPivotUrl({
        source: locator.origAddr,
        window: "1d",
      }),
    },
    {
      id: "same-destination",
      label: labels.sameDestination,
      windowLabel: labels.lastDay,
      href: buildDetectionPivotUrl({
        destination: locator.respAddr,
        window: "1d",
      }),
    },
    {
      id: "same-kind",
      label: labels.sameKind,
      windowLabel: labels.lastWeek,
      href: buildDetectionPivotUrl({
        kind: locator.kind,
        window: "7d",
      }),
    },
    {
      // Session/flow pivot is limited to {source, destination} in v1.
      // REview's EventListFilterInput has no origPort / respPort / proto
      // fields yet, so encoding them into the URL would produce a click-
      // through result list that does not actually narrow to the flow —
      // the Count / Last seen snippet computed on this page uses the same
      // 2-tuple so the two stay consistent. When REview adds port / proto
      // filters, re-add them both here and in fetchRelatedPivotSummaries.
      id: "same-session",
      label: labels.sameSession,
      windowLabel: labels.lastDay,
      href: buildDetectionPivotUrl({
        source: locator.origAddr,
        destination: locator.respAddr,
        window: "1d",
      }),
    },
  ];

  const [summaries, setSummaries] = useState<Record<
    PivotId,
    RelatedPivotSummary
  > | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchRelatedPivotSummaries(locator)
      .then((rows) => {
        if (cancelled) return;
        const map = Object.fromEntries(rows.map((r) => [r.id, r])) as Record<
          PivotId,
          RelatedPivotSummary
        >;
        setSummaries(map);
      })
      .catch(() => {
        if (!cancelled)
          setSummaries({} as Record<PivotId, RelatedPivotSummary>);
      });
    return () => {
      cancelled = true;
    };
  }, [locator]);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-xs">{labels.note}</p>
      <ul className="border-border bg-card divide-y divide-[var(--border)] rounded-md border">
        {pivots.map((pivot) => {
          const summary = summaries?.[pivot.id];
          return (
            <li key={pivot.id} className="p-3">
              <Link
                href={pivot.href}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span className="flex flex-col">
                  <span className="text-foreground font-medium">
                    {pivot.label}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {pivot.windowLabel}
                  </span>
                </span>
                <span className="flex items-center gap-3">
                  <PivotSnippet
                    summary={summary ?? null}
                    loading={summaries === null}
                    labels={labels}
                  />
                  <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
                    {labels.openInSearch}
                    <ExternalLink className="size-3.5" aria-hidden="true" />
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PivotSnippet({
  summary,
  loading,
  labels,
}: {
  summary: RelatedPivotSummary | null;
  loading: boolean;
  labels: RelatedLabels;
}) {
  if (loading) {
    return (
      <span
        role="status"
        aria-live="polite"
        className="text-muted-foreground text-xs"
      >
        {labels.loading}
      </span>
    );
  }
  if (!summary || summary.count === "0") {
    return <span className="text-muted-foreground text-xs">{labels.none}</span>;
  }
  return (
    <span className="text-muted-foreground flex flex-col items-end text-xs">
      <span>
        {labels.count}: {summary.count}
      </span>
      {summary.lastTime ? (
        <span>
          {labels.lastSeen}:{" "}
          <time dateTime={summary.lastTime}>{summary.lastTime}</time>
        </span>
      ) : null}
    </span>
  );
}
