"use client";

import { ExternalLink } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Link } from "@/i18n/navigation";
import type { Event } from "@/lib/detection/types";
import { buildDetectionPivotUrl } from "@/lib/detection/url-filters";
import {
  fetchRelatedPivotSummaries,
  type PivotId,
  type RelatedPivotAnchor,
  type RelatedPivotSummary,
} from "@/lib/events/related-pivots";

import { readEventAddressing } from "../event-display-helpers";

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
  event: Event;
  labels: RelatedLabels;
  /**
   * Customer IDs the operator was narrowed to on the originating
   * Detection page (#384). Forwarded onto each Related pivot URL
   * so the click-through preserves the customer narrowing.
   */
  customers?: readonly string[];
}

interface PivotEntry {
  id: PivotId;
  label: string;
  windowLabel: string;
  href: string;
}

export function RelatedTab({ event, labels, customers }: Props) {
  const addressing = readEventAddressing(event);
  const sourceAddr = addressing.origAddr ?? addressing.origAddrs[0];
  const destAddr = addressing.respAddr ?? addressing.respAddrs[0];
  const anchor: RelatedPivotAnchor = useMemo(
    () => ({
      time: event.time,
      kind: event.__typename,
      origAddr: sourceAddr ?? null,
      respAddr: destAddr ?? null,
    }),
    [event.time, event.__typename, sourceAddr, destAddr],
  );
  const customerList =
    customers && customers.length > 0 ? [...customers] : undefined;
  const pivots: PivotEntry[] = [];
  if (sourceAddr) {
    pivots.push({
      id: "same-source",
      label: labels.sameSource,
      windowLabel: labels.lastDay,
      href: buildDetectionPivotUrl({
        source: sourceAddr,
        window: "1d",
        customers: customerList,
      }),
    });
  }
  if (destAddr) {
    pivots.push({
      id: "same-destination",
      label: labels.sameDestination,
      windowLabel: labels.lastDay,
      href: buildDetectionPivotUrl({
        destination: destAddr,
        window: "1d",
        customers: customerList,
      }),
    });
  }
  pivots.push({
    id: "same-kind",
    label: labels.sameKind,
    windowLabel: labels.lastWeek,
    href: buildDetectionPivotUrl({
      kind: event.__typename,
      window: "7d",
      customers: customerList,
    }),
  });
  if (sourceAddr && destAddr) {
    // Session/flow pivot is limited to {source, destination} in v1.
    // REview's EventListFilterInput has no origPort / respPort / proto
    // fields yet, so encoding them into the URL would produce a click-
    // through result list that does not actually narrow to the flow —
    // the Count / Last seen snippet computed on this page uses the same
    // 2-tuple so the two stay consistent. When REview adds port / proto
    // filters, re-add them both here and in fetchRelatedPivotSummaries.
    pivots.push({
      id: "same-session",
      label: labels.sameSession,
      windowLabel: labels.lastDay,
      href: buildDetectionPivotUrl({
        source: sourceAddr,
        destination: destAddr,
        window: "1d",
        customers: customerList,
      }),
    });
  }

  const [summaries, setSummaries] = useState<Record<
    PivotId,
    RelatedPivotSummary
  > | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchRelatedPivotSummaries(anchor)
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
  }, [anchor]);

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
