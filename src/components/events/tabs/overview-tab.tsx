import { Badge } from "@/components/ui/badge";
import { Link } from "@/i18n/navigation";
import type { Event } from "@/lib/detection/types";
import { buildDetectionPivotUrl } from "@/lib/detection/url-filters";
import type { EventLocator } from "@/lib/events/event-locator";
import { EVENT_KIND_FRIENDLY_NAMES } from "../event-display-helpers";
import { AimerBanner } from "../event-investigation";

export interface OverviewLabels {
  summary: string;
  time: string;
  kind: string;
  category: string;
  level: string;
  confidence: string;
  triageScores: string;
  noTriage: string;
  aimerTitle: string;
  aimerBody: string;
  aimerCta: string;
  aimerToast: string;
  pivotsTitle: string;
  pivotSameSource: string;
  pivotSameDestination: string;
  pivotSameKind: string;
}

interface Props {
  event: Event;
  locator: EventLocator;
  labels: OverviewLabels;
}

export function OverviewTab({ event, locator, labels }: Props) {
  const friendly =
    EVENT_KIND_FRIENDLY_NAMES[event.__typename] ?? event.__typename;
  const pivots = [
    {
      id: "same-source",
      label: labels.pivotSameSource,
      href: buildDetectionPivotUrl({
        source: locator.origAddr,
        window: "1d",
      }),
    },
    {
      id: "same-destination",
      label: labels.pivotSameDestination,
      href: buildDetectionPivotUrl({
        destination: locator.respAddr,
        window: "1d",
      }),
    },
    {
      id: "same-kind",
      label: labels.pivotSameKind,
      href: buildDetectionPivotUrl({
        kind: locator.kind,
        window: "7d",
      }),
    },
  ];
  return (
    <div className="flex flex-col gap-6">
      <section
        aria-labelledby="overview-summary-heading"
        className="border-border bg-card flex flex-col gap-3 rounded-md border p-4"
      >
        <h2
          id="overview-summary-heading"
          className="text-foreground text-sm font-semibold"
        >
          {labels.summary}
        </h2>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          <Row label={labels.time}>
            <time dateTime={event.time}>{event.time}</time>
          </Row>
          <Row label={labels.kind}>{friendly}</Row>
          <Row label={labels.category}>{event.category ?? "—"}</Row>
          <Row label={labels.level}>
            <Badge variant="outline">{event.level}</Badge>
          </Row>
          <Row label={labels.confidence}>{event.confidence.toFixed(2)}</Row>
          <Row label={labels.triageScores}>
            {event.triageScores && event.triageScores.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {event.triageScores.map((score) => (
                  <li key={score.policyId}>
                    <span className="text-muted-foreground">
                      {score.policyId}
                    </span>{" "}
                    · {score.score}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-muted-foreground">{labels.noTriage}</span>
            )}
          </Row>
        </dl>
      </section>

      <AimerBanner
        label={labels.aimerTitle}
        body={labels.aimerBody}
        cta={labels.aimerCta}
        toast={labels.aimerToast}
      />

      <section
        aria-labelledby="overview-pivots-heading"
        className="border-border bg-card flex flex-col gap-2 rounded-md border p-4"
      >
        <h2
          id="overview-pivots-heading"
          className="text-foreground text-sm font-semibold"
        >
          {labels.pivotsTitle}
        </h2>
        <ul className="flex flex-col gap-1 text-sm">
          {pivots.map((pivot) => (
            <li key={pivot.id}>
              <Link
                href={pivot.href}
                className="text-foreground hover:underline"
              >
                · {pivot.label}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5 text-sm">
      <dt className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
        {label}
      </dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  );
}
