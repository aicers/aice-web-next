"use client";

import { Check, Copy, ExternalLink, X } from "lucide-react";
import { useEffect, useState } from "react";
import { MorePopover } from "@/components/detection/more-popover";
import {
  EVENT_KIND_FRIENDLY_NAMES,
  levelBadgeVariant,
  readEventAddressing,
} from "@/components/events/event-display-helpers";
import { Badge } from "@/components/ui/badge";
import { Link } from "@/i18n/navigation";
import { formatEventTime } from "@/lib/detection/event-time";
import type { RenderedHighlight } from "@/lib/detection/quick-peek-highlights";
import { pickHighlightValues } from "@/lib/detection/quick-peek-highlights";
import type {
  Event as DetectionEvent,
  LearningMethod,
  ThreatCategory,
  ThreatLevel,
  TriageScore,
} from "@/lib/detection/types";
import { buildDetectionPivotUrl } from "@/lib/detection/url-filters";
import { cn } from "@/lib/utils";

/**
 * Labels for the Quick peek inspector. Like the rest of the shell,
 * function-valued formatters are built on the client side (so the
 * translator can close over the active locale) and plain strings
 * arrive from the server page.
 */
export interface QuickPeekInspectorLabels {
  close: string;
  summaryHeading: string;
  endpointsHeading: string;
  detectionMetaHeading: string;
  protocolHeading: string;
  actionsHeading: string;
  sourceLabel: string;
  destinationLabel: string;
  sensorLabel: string;
  attackKindLabel: string;
  learningMethodLabel: string;
  learningMethodValues: Record<LearningMethod, string>;
  confidenceLabel: string;
  categoryLabels: Record<ThreatCategory, string>;
  levelLabels: Record<ThreatLevel, string>;
  triageSummary: (args: { count: number; max: string }) => string;
  protocolFields: Record<string, string>;
  /** Friendly boolean labels (yes / no) for boolean highlight values. */
  booleanTrue: string;
  booleanFalse: string;
  openInvestigation: string;
  openInvestigationTooltip: string;
  pivotSource: string;
  pivotDestination: string;
  pivotKind: string;
  copy: string;
  copied: string;
  moreCountSuffix: (count: number) => string;
  countryUnknown: string;
  countryUnavailable: string;
  portSeparator: string;
  unknownTime: string;
  noSensor: string;
}

export interface QuickPeekInspectorProps {
  event: DetectionEvent;
  labels: QuickPeekInspectorLabels;
  locale: string;
  /**
   * Full href for the "Open full investigation" anchor. Must be
   * absolute-from-root (`/events/<token>?returnTo=...`) so middle-
   * click / Cmd+click opens in a new tab. When null the event is
   * not addressable and the action is omitted rather than disabled.
   */
  investigateHref: string | null;
  onClose: () => void;
  /** Density affordance: omit the inline close button on overlays (the Sheet supplies its own). */
  showClose?: boolean;
  /**
   * Customer IDs from the active Detection filter (#384). Threaded
   * onto the per-IP / per-kind pivot URLs so a click-through
   * preserves the operator's customer narrowing rather than landing
   * on the unfiltered set. Undefined when no customer filter is
   * active.
   */
  customers?: readonly string[];
}

/**
 * Quick peek inspector body for a single event.
 *
 * Renders:
 * - Header (kind + time + optional close)
 * - Summary (severity / category / confidence / triage)
 * - Endpoints (source and destination IP[:port] (country) with
 *   `+N more` popovers for array-responder subtypes and an inline
 *   copy-to-clipboard button on each IP)
 * - Detection meta (sensor, attack kind, learning method — hidden
 *   when the field is empty rather than rendered as "(Not Provided)")
 * - Protocol highlights (per-subtype short list; see
 *   `QUICK_PEEK_HIGHLIGHTS`)
 * - Actions (Open full investigation — real `<a>` tag so middle-
 *   click / Cmd+click works — plus per-IP and per-kind pivot
 *   links into Detection)
 *
 * The component is shared between the desktop inline right-hand
 * pane and the narrow-viewport overlay Sheet; the shell picks
 * which container to wrap it in based on the desktop-breakpoint
 * media query.
 */
export function QuickPeekInspector({
  event,
  labels,
  locale,
  investigateHref,
  onClose,
  showClose = true,
  customers,
}: QuickPeekInspectorProps) {
  const kindLabel =
    EVENT_KIND_FRIENDLY_NAMES[event.__typename] ?? event.__typename;
  const timeLabel = formatEventTime(event.time, locale, labels.unknownTime);
  const addressing = readEventAddressing(event);
  const highlights = pickHighlightValues(event);
  const categoryLabel = event.category
    ? (labels.categoryLabels[event.category] ?? event.category)
    : null;
  const learningMethod = (event as { learningMethod?: LearningMethod })
    .learningMethod;
  const sourceChip = formatEndpoint(
    addressing.origAddr,
    addressing.origAddrs,
    addressing.origPort,
    addressing.origCountry,
    addressing.origCountries,
    null,
  );
  const destChip = formatEndpoint(
    addressing.respAddr,
    addressing.respAddrs,
    addressing.respPort,
    addressing.respCountry,
    addressing.respCountries,
    addressing.respPorts,
  );
  return (
    <div
      className="flex flex-1 flex-col overflow-hidden"
      data-slot="quick-peek-inspector"
    >
      <header className="flex items-start gap-2 border-b border-[var(--sidebar-border)] px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-foreground truncate text-sm font-semibold">
            {kindLabel}
          </span>
          <time dateTime={event.time} className="text-muted-foreground text-xs">
            {timeLabel}
          </time>
        </div>
        {showClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label={labels.close}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex size-7 items-center justify-center rounded-sm focus-visible:ring-2 focus-visible:outline-none"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </header>
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 pt-3 pb-4 text-sm">
        <Section heading={labels.summaryHeading}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={levelBadgeVariant(event.level)}
              className="uppercase"
            >
              {labels.levelLabels[event.level] ?? event.level}
            </Badge>
            {categoryLabel ? (
              <Badge variant="outline" className="font-normal">
                {categoryLabel}
              </Badge>
            ) : null}
            <span className="text-muted-foreground text-xs">
              <span className="mr-1">{labels.confidenceLabel}</span>
              <span className="text-foreground tabular-nums">
                {event.confidence.toFixed(2)}
              </span>
            </span>
            <TriageSummary triageScores={event.triageScores} labels={labels} />
          </div>
        </Section>

        {sourceChip || destChip ? (
          <Section heading={labels.endpointsHeading}>
            <dl className="flex flex-col gap-1.5 text-xs">
              {sourceChip ? (
                <EndpointRow
                  termLabel={labels.sourceLabel}
                  chip={sourceChip}
                  labels={labels}
                />
              ) : null}
              {destChip ? (
                <EndpointRow
                  termLabel={labels.destinationLabel}
                  chip={destChip}
                  labels={labels}
                />
              ) : null}
            </dl>
          </Section>
        ) : null}

        <Section heading={labels.detectionMetaHeading}>
          <dl className="flex flex-col gap-1.5 text-xs">
            <MetaRow
              termLabel={labels.sensorLabel}
              value={event.sensor || labels.noSensor}
            />
            {addressing.attackKind ? (
              <MetaRow
                termLabel={labels.attackKindLabel}
                value={addressing.attackKind}
              />
            ) : null}
            {learningMethod ? (
              <MetaRow
                termLabel={labels.learningMethodLabel}
                value={
                  labels.learningMethodValues[learningMethod] ?? learningMethod
                }
              />
            ) : null}
          </dl>
        </Section>

        {highlights.length > 0 ? (
          <Section heading={labels.protocolHeading}>
            <dl className="flex flex-col gap-1.5 text-xs">
              {highlights.map((h) => (
                <ProtocolRow key={h.labelKey} highlight={h} labels={labels} />
              ))}
            </dl>
          </Section>
        ) : null}

        <Section heading={labels.actionsHeading}>
          <div className="flex flex-col gap-2">
            {investigateHref ? (
              <Link
                href={investigateHref}
                // A real anchor tag (middle-click / Cmd+click opens in
                // a new browser tab). `next-intl`'s `Link` wraps
                // Next's `<Link>`, which renders a proper `<a>` with
                // locale-aware prefixing.
                className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring/50 inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium focus-visible:ring-2 focus-visible:outline-none"
                title={labels.openInvestigationTooltip}
              >
                <ExternalLink className="size-3.5" aria-hidden="true" />
                {labels.openInvestigation}
              </Link>
            ) : null}
            <Pivots
              event={event}
              labels={labels}
              addressing={addressing}
              customers={customers}
            />
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wide">
        {heading}
      </h3>
      {children}
    </section>
  );
}

function MetaRow({ termLabel, value }: { termLabel: string; value: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,5.5rem)_minmax(0,1fr)] gap-x-2">
      <dt className="text-muted-foreground truncate">{termLabel}</dt>
      <dd className="text-foreground min-w-0 break-all">{value}</dd>
    </div>
  );
}

function ProtocolRow({
  highlight,
  labels,
}: {
  highlight: RenderedHighlight;
  labels: QuickPeekInspectorLabels;
}) {
  const termLabel =
    labels.protocolFields[highlight.labelKey] ?? highlight.labelKey;
  return (
    <div className="grid grid-cols-[minmax(0,6rem)_minmax(0,1fr)] gap-x-2">
      <dt className="text-muted-foreground truncate">{termLabel}</dt>
      <dd className="text-foreground flex min-w-0 flex-wrap items-center gap-1 break-all font-mono">
        {renderHighlightValue(highlight, labels)}
      </dd>
    </div>
  );
}

function renderHighlightValue(
  highlight: RenderedHighlight,
  labels: QuickPeekInspectorLabels,
): React.ReactNode {
  const value = highlight.value;
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") {
    return value ? labels.booleanTrue : labels.booleanFalse;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    // Show up to three values inline; fold the remainder into the
    // shared `+N more` popover so the operator can still inspect
    // hidden values without expanding the inspector pane. When the
    // highlight is copyable (hostname / userId-style), propagate the
    // Copy affordance into the popover so overflowed values stay
    // copy-able too.
    const all = value.map((v) => String(v));
    const shown = all.slice(0, 3);
    const extras = all.slice(3);
    return (
      <span className="flex flex-wrap items-center gap-1">
        {shown.map((v) => (
          <span
            key={v}
            className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]"
          >
            <span>{v}</span>
            {highlight.copyable ? (
              <CopyButton value={v} labels={labels} />
            ) : null}
          </span>
        ))}
        {extras.length > 0 ? (
          <MorePopover
            count={extras.length}
            values={extras}
            moreCountSuffix={labels.moreCountSuffix}
            copyLabels={
              highlight.copyable
                ? { copy: labels.copy, copied: labels.copied }
                : undefined
            }
          />
        ) : null}
      </span>
    );
  }
  const text = String(value);
  return (
    <>
      <span>{text}</span>
      {highlight.copyable ? <CopyButton value={text} labels={labels} /> : null}
    </>
  );
}

/**
 * Rendered source/destination endpoint — a list of
 * `(address, port?, country?)` tuples. The first
 * {@link INLINE_ENDPOINT_COUNT} tuples render inline as
 * `IP[:port] (country)`; the remainder collapses into the
 * shared `+N more` popover.
 *
 * A non-null primary address is guaranteed (the caller returns
 * `null` when no addresses are present), so the first tuple is
 * always renderable.
 */
interface EndpointTuple {
  address: string;
  port: number | null;
  country: string | null;
}

interface EndpointChip {
  tuples: EndpointTuple[];
}

/**
 * How many endpoint tuples to render inline before folding into the
 * `+N more` popover. Mirrors the protocol-highlight array convention
 * above so the two sections handle overflow the same way.
 */
const INLINE_ENDPOINT_COUNT = 3;

function formatEndpoint(
  singularAddr: string | null,
  pluralAddrs: string[],
  singularPort: number | null,
  singularCountry: string | null,
  pluralCountries: string[],
  pluralPorts: number[] | null,
): EndpointChip | null {
  const addresses = singularAddr ? [singularAddr] : pluralAddrs.slice();
  if (addresses.length === 0) return null;
  const ports =
    singularPort !== null
      ? [singularPort]
      : pluralPorts
        ? pluralPorts.slice()
        : [];
  const countries = singularCountry
    ? [singularCountry]
    : pluralCountries.slice();
  // Subtypes may provide the address array and the country array at
  // different lengths, or may share one address across many ports
  // (e.g. PortScan's `respPorts` with a singular `respAddr`). Iterate
  // up to the longest column and back-fill the shorter ones from the
  // primary values so every tuple still renders a complete
  // `IP[:port] (country)` triple rather than a bare port number.
  const length = Math.max(addresses.length, ports.length, countries.length);
  const primaryAddress = addresses[0];
  const primaryPort = ports[0] ?? null;
  const primaryCountry = countries[0] ?? null;
  const tuples: EndpointTuple[] = [];
  for (let i = 0; i < length; i += 1) {
    const address = addresses[i] ?? primaryAddress;
    // Prefer the per-index port when present; otherwise fall back to
    // the primary port so a shared scalar (e.g. `MultiHostPortScan`'s
    // `respPort=22` alongside an array of `respAddrs`) still decorates
    // every tuple rather than dropping the port on entries after the
    // first.
    const port = ports[i] !== undefined ? ports[i] : primaryPort;
    const country = countries[i] ?? primaryCountry;
    tuples.push({ address, port, country });
  }
  return { tuples };
}

function EndpointRow({
  termLabel,
  chip,
  labels,
}: {
  termLabel: string;
  chip: EndpointChip;
  labels: QuickPeekInspectorLabels;
}) {
  const inline = chip.tuples.slice(0, INLINE_ENDPOINT_COUNT);
  const overflow = chip.tuples.slice(INLINE_ENDPOINT_COUNT);
  const overflowValues = overflow.map((t) => formatEndpointTuple(t, labels));
  // Popover Copy should yield the raw IP — the same value the inline
  // `CopyButton` emits — rather than the formatted `IP[:port]
  // (country)` string the operator sees in the popover.
  const overflowCopyValues = overflow.map((t) => t.address);
  return (
    <div className="grid grid-cols-[minmax(0,5.5rem)_minmax(0,1fr)] gap-x-2">
      <dt className="text-muted-foreground truncate">{termLabel}</dt>
      <dd className="text-foreground flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 break-all">
        {inline.map((tuple, index) => {
          const countryLabel = tuple.country
            ? formatCountryShort(tuple.country, labels)
            : null;
          const portText =
            tuple.port !== null ? `${labels.portSeparator}${tuple.port}` : "";
          // Parallel arrays may occasionally produce textually
          // identical tuples (e.g. two detections with the same
          // `IP:port (country)` triple), so the index disambiguates
          // them. The list is stable across renders — never reordered —
          // so an index-based key is safe here.
          const key = `${tuple.address}-${tuple.port ?? "np"}-${tuple.country ?? "nc"}-${index}`;
          return (
            <span key={key} className="inline-flex items-center gap-1">
              <span className="font-mono">
                {tuple.address}
                {portText}
              </span>
              {countryLabel ? (
                <span className="text-muted-foreground">({countryLabel})</span>
              ) : null}
              {/*
               * Copy-to-clipboard lives on every inline IP — the issue
               * promises copy on "source and destination IPs" and once
               * more than one IP is inlined, restricting it to the
               * first chip would hide the affordance for the rest.
               */}
              <CopyButton value={tuple.address} labels={labels} />
            </span>
          );
        })}
        {overflowValues.length > 0 ? (
          <MorePopover
            count={overflowValues.length}
            values={overflowValues}
            copyValues={overflowCopyValues}
            copyLabels={{ copy: labels.copy, copied: labels.copied }}
            moreCountSuffix={labels.moreCountSuffix}
          />
        ) : null}
      </dd>
    </div>
  );
}

function formatEndpointTuple(
  tuple: EndpointTuple,
  labels: QuickPeekInspectorLabels,
): string {
  const parts: string[] = [tuple.address];
  if (tuple.port !== null) {
    parts.push(`${labels.portSeparator}${tuple.port}`);
  }
  const base = parts.join("");
  if (tuple.country) {
    const label = formatCountryShort(tuple.country, labels);
    return `${base} (${label})`;
  }
  return base;
}

function formatCountryShort(
  code: string,
  labels: QuickPeekInspectorLabels,
): string {
  if (code === "XX") return labels.countryUnknown;
  if (code === "ZZ") return labels.countryUnavailable;
  return code;
}

function TriageSummary({
  triageScores,
  labels,
}: {
  triageScores: TriageScore[] | null;
  labels: QuickPeekInspectorLabels;
}) {
  if (!triageScores || triageScores.length === 0) return null;
  let max = triageScores[0].score;
  for (const t of triageScores) if (t.score > max) max = t.score;
  return (
    <span className="text-muted-foreground text-xs">
      {labels.triageSummary({
        count: triageScores.length,
        max: max.toFixed(2),
      })}
    </span>
  );
}

function CopyButton({
  value,
  labels,
}: {
  value: string;
  labels: QuickPeekInspectorLabels;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const handle = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(handle);
  }, [copied]);
  return (
    <button
      type="button"
      aria-label={copied ? labels.copied : labels.copy}
      className={cn(
        "text-muted-foreground/60 hover:text-foreground focus-visible:ring-ring/50 inline-flex size-5 items-center justify-center rounded-sm transition-opacity focus-visible:ring-2 focus-visible:outline-none",
      )}
      onClick={(event) => {
        event.stopPropagation();
        if (
          typeof navigator !== "undefined" &&
          navigator.clipboard &&
          typeof navigator.clipboard.writeText === "function"
        ) {
          void navigator.clipboard.writeText(value).then(
            () => setCopied(true),
            () => {},
          );
        }
      }}
    >
      {copied ? (
        <Check className="size-3" aria-hidden="true" />
      ) : (
        <Copy className="size-3" aria-hidden="true" />
      )}
    </button>
  );
}

/**
 * Pivot links into Detection — same-source / same-destination / same-kind.
 * Each is a real anchor so middle-click / Cmd+click opens a new tab.
 * Pivot targets that are not present on the event (e.g. source IP
 * on a response-only subtype) are omitted rather than rendered as
 * no-op buttons.
 */
function Pivots({
  event,
  labels,
  addressing,
  customers,
}: {
  event: DetectionEvent;
  labels: QuickPeekInspectorLabels;
  addressing: ReturnType<typeof readEventAddressing>;
  customers?: readonly string[];
}) {
  const source =
    addressing.origAddr ??
    (addressing.origAddrs.length > 0 ? addressing.origAddrs[0] : null);
  const destination =
    addressing.respAddr ??
    (addressing.respAddrs.length > 0 ? addressing.respAddrs[0] : null);
  const customerList =
    customers && customers.length > 0 ? [...customers] : undefined;
  const items: { key: string; href: string; label: string }[] = [];
  if (source) {
    items.push({
      key: "same-source",
      href: buildDetectionPivotUrl({
        source,
        window: "1d",
        customers: customerList,
      }),
      label: labels.pivotSource,
    });
  }
  if (destination) {
    items.push({
      key: "same-destination",
      href: buildDetectionPivotUrl({
        destination,
        window: "1d",
        customers: customerList,
      }),
      label: labels.pivotDestination,
    });
  }
  items.push({
    key: "same-kind",
    href: buildDetectionPivotUrl({
      kind: event.__typename,
      window: "7d",
      customers: customerList,
    }),
    label: labels.pivotKind,
  });
  return (
    <ul className="flex flex-col gap-1 text-xs">
      {items.map((item) => (
        <li key={item.key}>
          <Link
            href={item.href}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 hover:underline"
          >
            <span aria-hidden="true">·</span>
            {item.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}
