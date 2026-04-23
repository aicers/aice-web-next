"use client";

import { ArrowRight, ExternalLink } from "lucide-react";
import {
  EVENT_KIND_FRIENDLY_NAMES,
  levelBadgeVariant,
} from "@/components/events/event-display-helpers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Link } from "@/i18n/navigation";
import type {
  Event,
  EventBase,
  ThreatCategory,
  ThreatLevel,
} from "@/lib/detection/types";
import { buildDetectionPivotUrl } from "@/lib/detection/url-filters";
import { isEventAddressable } from "@/lib/events/event-locator";
import { formatDateTime } from "@/lib/format-date";

export interface EventRowLabels {
  /** Tooltip / aria label for the investigation affordance. */
  openInvestigation: string;
  /** Tooltip wrapping the numeric confidence (`Confidence 0.87`). */
  confidence: string;
  /** Triage summary template (`{count, plural, ...}` ICU). */
  triageSummary: string;
  /** Placeholder for missing addressing (e.g. WindowsThreat). */
  unknownEndpoint: string;
  /** `Attack: {kind}` template for the ML-subtype attackKind label. */
  attackKindLabel: string;
  /** `+N more` template for arrayed addressing fields. */
  moreCount: string;
  /** Heading for the `+N more` popover over an address array. */
  moreAddressesTitle: string;
  /** `N addresses` summary text shown inside the address popover. */
  moreAddressesCount: string;
  /** Heading for the `+N more` popover over a port array. */
  morePortsTitle: string;
  /** `N ports` summary text shown inside the port popover. */
  morePortsCount: string;
  /**
   * Template for the row-level Quick peek trigger's accessible
   * name. Composed from the row's distinguishing fields so screen
   * reader / keyboard users can tell neighbouring rows apart — the
   * stretched-button overlay would otherwise read as a bare
   * `<kind>` and collapse onto its siblings when multiple rows
   * share the same kind. Tokens: `{level}`, `{time}`, `{kind}`,
   * `{source}`, `{destination}`, `{sensor}`.
   */
  rowTrigger: string;
  /**
   * `Pivot on {kind}` template for the kind cell's pivot link
   * accessible name. Phase Detection-12 owns the full pivot
   * behaviour; v1 ships the URL handoff supported by
   * `buildDetectionPivotUrl` (same-kind / same-source-IP /
   * same-destination-IP) so the "click anywhere except a pivot
   * link opens Quick peek" contract has real pivot links to
   * satisfy.
   */
  pivotKind: string;
  /** `Pivot on source IP {value}` template. */
  pivotSourceIp: string;
  /** `Pivot on destination IP {value}` template. */
  pivotDestinationIp: string;
  /**
   * Localized `ThreatCategory` labels, keyed by the enum string
   * REview returns (`RECONNAISSANCE`, `INITIAL_ACCESS`, …). Built
   * from the same `filters.categoryOptions.*` messages the drawer
   * uses so row chips and the drawer agree on locale. Unknown
   * categories fall back to the raw enum string.
   */
  categoryLabels: Partial<Record<ThreatCategory, string>>;
}

interface EventRowProps {
  event: Event;
  labels: EventRowLabels;
  onSelect?: (event: Event) => void;
  onOpenInvestigation?: (event: Event) => void;
}

/**
 * Compact two-line entry for the Detection result list.
 *
 * Line 1: severity + time + kind/category + confidence + triage.
 * Line 2: source endpoint → destination endpoint + sensor.
 *
 * The component never hides the destination or severity — the
 * responsive strategy is density (tighter spacing, vertical
 * stacking on narrow viewports), not column drop. See Phase
 * Detection-9 spec.
 */
export function EventRow({
  event,
  labels,
  onSelect,
  onOpenInvestigation,
}: EventRowProps) {
  const friendlyKind =
    EVENT_KIND_FRIENDLY_NAMES[event.__typename] ?? event.__typename;
  const attackKind = readString(event, "attackKind");
  const triage = summariseTriage(event);
  const triageLabel = triage
    ? labels.triageSummary
        .replace("{count}", String(triage.count))
        .replace("{max}", triage.maxLabel)
    : null;

  const source = resolveEndpoint(event, "orig", labels);
  const destination = resolveEndpoint(event, "resp", labels);
  // Several subtypes cannot render a full `source IP:port → dest
  // IP:port` pair because the REview schema does not expose the
  // missing fields. The row degrades gracefully per subtype rather
  // than dropping the row — these are the documented exceptions to
  // the spec's "every Event subtype renders source/destination
  // IP+port" line and are not bugs the UI can fix without widening
  // the schema:
  //   * `ExtraThreat`  (schemas/review.graphql:3975) and
  //     `WindowsThreat` (schemas/review.graphql:8104) — host-based
  //     process / pattern events with no `origAddr` / `respAddr`.
  //     Both endpoints render `—`; Investigation is hidden below
  //     because the locator token cannot be built.
  //   * `ExternalDdos` (schemas/review.graphql:3865) — no ports on
  //     either side; IPs + countries render without `:port` suffix.
  //   * `FtpBruteForce` (schemas/review.graphql:4043) and
  //     `LdapBruteForce` (schemas/review.graphql:4640) — no
  //     `origPort`; source renders with no port, destination keeps
  //     its port.
  //   * `RdpBruteForce` (schemas/review.graphql:6697) — no
  //     `respPort`; destination renders with no port suffix.
  //   * `UnusualDestinationPattern` (schemas/review.graphql:8015) —
  //     no originator at all. Source renders `—`, destination
  //     renders IPs + countries, and Investigation is hidden below
  //     because `isEventAddressable` requires an originator.
  const canOpenInvestigation = isEventAddressable(event);

  // Compose the row-level trigger's accessible name from the
  // visible distinguishing fields. Without this, the stretched
  // button overlay only announces the kind, so a screen-reader /
  // keyboard user navigating a list of "HTTP Threat" rows cannot
  // tell neighbouring rows apart. See Phase Detection-9 a11y item.
  const rowTriggerLabel = labels.rowTrigger
    .replace("{level}", event.level)
    .replace("{time}", formatDateTime(event.time))
    .replace(
      "{kind}",
      attackKind ? `${friendlyKind} (${attackKind})` : friendlyKind,
    )
    .replace("{source}", source.primary)
    .replace("{destination}", destination.primary)
    .replace("{sensor}", event.sensor);

  return (
    <li className="bg-card relative flex items-stretch gap-0 border-b border-[var(--sidebar-border)] last:border-b-0 focus-within:bg-[var(--muted)]/40 hover:bg-[var(--muted)]/40">
      {/* Stretched-button overlay: the Quick peek trigger covers the
          whole row body but lives as a DOM sibling of the endpoint
          popover triggers and the Investigation button. Everything
          else stays outside this element, so we never nest one
          interactive control inside another — popover triggers and
          the Investigation button re-enable pointer events on top
          of the overlay via `pointer-events-auto`. */}
      <button
        type="button"
        className="focus-visible:ring-ring absolute inset-0 z-0 cursor-pointer focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none"
        onClick={() => onSelect?.(event)}
        aria-label={rowTriggerLabel}
      />
      <div className="pointer-events-none relative z-10 flex min-w-0 flex-1 flex-col gap-1.5 px-3 py-2.5 sm:px-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <Badge
            variant={levelBadgeVariant(event.level)}
            className="shrink-0 uppercase"
            aria-label={event.level}
          >
            {event.level}
          </Badge>
          <time
            dateTime={event.time}
            className="text-foreground shrink-0 font-mono text-xs"
          >
            {formatDateTime(event.time)}
          </time>
          <PivotLink
            href={buildDetectionPivotUrl({
              kind: event.__typename,
              window: "7d",
            })}
            aria-label={labels.pivotKind.replace("{kind}", friendlyKind)}
            className="text-foreground truncate text-sm font-medium"
          >
            {friendlyKind}
          </PivotLink>
          {attackKind ? (
            // `pointer-events-auto` so the native hover tooltip
            // (`title`) still fires on medium viewports where the
            // `attackKind` string is truncated with ellipsis. Without
            // this, the ancestor's `pointer-events-none` suppresses
            // hover entirely, breaking the required tooltip. The
            // explicit click handler forwards activation to the row
            // overlay so clicking the text still opens Quick peek.
            //
            // Hidden below `sm` so the narrow-viewport density rule
            // is met: severity, time, kind, and the endpoints stay
            // visible while the `attackKind` secondary label collapses
            // away — same pattern used for the `category` span below.
            <button
              type="button"
              onClick={() => onSelect?.(event)}
              title={attackKind}
              className="text-muted-foreground pointer-events-auto relative z-10 hidden truncate bg-transparent text-left text-xs sm:inline-block"
            >
              {labels.attackKindLabel.replace("{kind}", attackKind)}
            </button>
          ) : null}
          {event.category ? (
            <span className="text-muted-foreground hidden text-xs sm:inline">
              {humaniseCategory(event.category, labels)}
            </span>
          ) : null}
          <span
            className="text-muted-foreground ml-auto shrink-0 font-mono text-xs"
            title={labels.confidence.replace(
              "{value}",
              event.confidence.toFixed(2),
            )}
          >
            {event.confidence.toFixed(2)}
          </span>
          {triageLabel ? (
            <span className="text-muted-foreground shrink-0 text-xs">
              {triageLabel}
            </span>
          ) : null}
        </div>

        <div className="text-muted-foreground flex w-full flex-col gap-0.5 text-xs sm:flex-row sm:items-center sm:gap-2">
          <EndpointCell endpoint={source} labels={labels} side="orig" />
          <ArrowRight
            className="hidden size-3 sm:inline-block"
            aria-hidden="true"
          />
          <EndpointCell endpoint={destination} labels={labels} side="resp" />
          <span className="ml-auto truncate text-xs" title={event.sensor}>
            {event.sensor}
          </span>
        </div>
      </div>
      {canOpenInvestigation ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={labels.openInvestigation}
          onClick={() => onOpenInvestigation?.(event)}
          className="pointer-events-auto relative z-10 shrink-0 self-stretch rounded-none px-2"
        >
          <ExternalLink className="size-4" aria-hidden="true" />
        </Button>
      ) : null}
    </li>
  );
}

interface EndpointShape {
  origAddr?: string;
  origAddrs?: string[];
  origPort?: number;
  origCountry?: string;
  origCountries?: string[];
  respAddr?: string;
  respAddrs?: string[];
  respPort?: number;
  respPorts?: number[];
  respCountry?: string;
  respCountries?: string[];
}

/**
 * Which collection the overflow popover is displaying. Drives the
 * popover heading and the count-label copy so an address list doesn't
 * get titled "All ports" (or vice versa).
 */
export type OverflowKind = "address" | "port";

/**
 * One entry inside the overflow popover. Kept structured (not a
 * flat string) so the renderer can wrap the IP portion in a pivot
 * link without string-parsing. Address-overflow entries have a
 * distinct per-row IP; port-overflow entries share the primary
 * row's IP (and so would pivot to the same destination). Both
 * shapes therefore expose `ip` as a pivotable token — matching the
 * spec's "cells that expose pivotable values (IP, …) render as
 * pivot links" rule for overflow rows too, not just the primary
 * line. See Round 13 reviewer item 2.
 */
export interface OverflowEntry {
  /** `ip[:port] (country)` — the full formatted label. */
  text: string;
  /** IP portion (e.g. `203.0.113.1`) — always present for entries. */
  ip: string;
  /** Port suffix (e.g. `:22`), empty string when no port is known. */
  portSuffix: string;
  /** Country short name to append in parentheses, null when absent. */
  country: string | null;
}

/**
 * Structured endpoint result: the visible primary line plus the
 * optional overflow set for the `+N more` popover. Split out so the
 * row can render the popover affordance itself — the inline `+N
 * more` was previously a plain string with no way for the operator
 * to inspect the hidden values.
 */
export interface ResolvedEndpoint {
  /** `10.0.0.5:443 (US)` — the first-entry decoration. */
  primary: string;
  /**
   * Raw IP string (e.g. `10.0.0.5`), unannotated with port or
   * country. Separated from `primary` so the row can wrap just the
   * IP in a pivot link. `null` when the endpoint has no addressing
   * (e.g. host-based subtypes).
   */
  primaryIp: string | null;
  /** Port suffix (e.g. `:443`), empty string when no port is known. */
  primaryPortSuffix: string;
  /** Country short name to display after the port. `null` when absent. */
  primaryCountry: string | null;
  /** Overflow collection kind, or null when there is no overflow. */
  overflowKind: OverflowKind | null;
  /**
   * Popover entries, in structured form so each entry's IP can be
   * rendered as a pivot link. Address arrays produce one entry per
   * collapsed IP (per-index country + shared port); port arrays
   * produce one entry per collapsed port (shared IP + country +
   * per-entry port). Empty when the endpoint has no overflow.
   */
  overflowEntries: readonly OverflowEntry[];
  /** Count of entries collapsed behind `+N more`. */
  extras: number;
}

export function resolveEndpoint(
  event: EventBase | Event,
  side: "orig" | "resp",
  labels: EventRowLabels,
): ResolvedEndpoint {
  const e = event as Partial<EndpointShape>;
  const addrArray = side === "orig" ? e.origAddrs : e.respAddrs;
  const countryArray = side === "orig" ? e.origCountries : e.respCountries;
  const portArray = side === "resp" ? e.respPorts : undefined;
  const addr =
    side === "orig"
      ? pickFirst(e.origAddr, e.origAddrs)
      : pickFirst(e.respAddr, e.respAddrs);
  if (!addr) {
    return {
      primary: labels.unknownEndpoint,
      primaryIp: null,
      primaryPortSuffix: "",
      primaryCountry: null,
      overflowKind: null,
      overflowEntries: [],
      extras: 0,
    };
  }
  const extras =
    side === "orig"
      ? extraCount(e.origAddrs)
      : extraCount(e.respAddrs) + extraCount(e.respPorts);
  const sharedPort =
    side === "orig" ? e.origPort : (e.respPort ?? pickFirstNumber(e.respPorts));
  const port = formatPort(sharedPort);
  const country =
    side === "orig"
      ? pickFirst(e.origCountry, e.origCountries)
      : pickFirst(e.respCountry, e.respCountries);
  const base = `${addr}${port}`;
  const primary = country ? `${base} (${country})` : base;

  // The popover should reveal everything that was collapsed out of
  // the primary line, formatted the same way (ip + port + country).
  // Address-array paths use the per-index country (`origCountries` /
  // `respCountries`) and the shared port; port-array paths (PortScan)
  // use the shared responder address + country with the per-entry
  // port. This keeps the popover honest with the spec contract:
  // "each endpoint renders as IP, port, country short name".
  let overflowKind: OverflowKind | null = null;
  let overflowEntries: OverflowEntry[] = [];
  if (Array.isArray(addrArray) && addrArray.length > 0) {
    overflowKind = "address";
    overflowEntries = addrArray.map((entryAddr, index) => {
      const entryCountry = Array.isArray(countryArray)
        ? (countryArray[index] ?? null)
        : (country ?? null);
      return buildOverflowEntry(entryAddr, sharedPort, entryCountry);
    });
  } else if (Array.isArray(portArray) && portArray.length > 0) {
    overflowKind = "port";
    overflowEntries = portArray.map((entryPort) =>
      buildOverflowEntry(addr, entryPort, country ?? null),
    );
  }

  return {
    primary,
    primaryIp: addr,
    primaryPortSuffix: port,
    primaryCountry: country ?? null,
    overflowKind,
    overflowEntries,
    extras,
  };
}

function formatEntry(
  address: string,
  port: number | undefined,
  country: string | null,
): string {
  const base = `${address}${formatPort(port)}`;
  return country ? `${base} (${country})` : base;
}

/**
 * React-key helper for the overflow popover. Two entries can
 * genuinely share the same `text` (e.g. a PortScan listing port 22
 * twice), so `text` alone isn't a stable unique key. This appends
 * an occurrence counter per text value so repeated entries get
 * distinct keys without falling back to the array index (which
 * Biome's `noArrayIndexKey` correctly flags as fragile — any
 * future in-place reorder would silently collide).
 */
function dedupeKeyedEntries(
  entries: readonly OverflowEntry[],
): { entry: OverflowEntry; key: string }[] {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const count = (seen.get(entry.text) ?? 0) + 1;
    seen.set(entry.text, count);
    return { entry, key: count === 1 ? entry.text : `${entry.text}#${count}` };
  });
}

/**
 * Build a structured popover entry. The `text` matches the flat
 * string format callers used previously, while `ip` / `portSuffix`
 * / `country` give the renderer what it needs to wrap just the IP
 * in a pivot link without re-parsing the composed label.
 */
function buildOverflowEntry(
  address: string,
  port: number | undefined,
  country: string | null,
): OverflowEntry {
  const portSuffix = formatPort(port);
  return {
    text: formatEntry(address, port, country),
    ip: address,
    portSuffix,
    country,
  };
}

/**
 * Renders an endpoint cell — the primary string, and when array
 * fields collapsed values, a `+N more` popover trigger. The trigger
 * sits above the row-level stretched-button overlay via
 * `pointer-events-auto`, so clicking it opens the popover without
 * bubbling into the Quick peek overlay and without nesting one
 * interactive control inside another.
 */
function EndpointCell({
  endpoint,
  labels,
  side,
}: {
  endpoint: ResolvedEndpoint;
  labels: EventRowLabels;
  side: "orig" | "resp";
}) {
  const primary = renderPrimary(endpoint, labels, side);
  if (endpoint.extras <= 0) {
    return (
      <span className="text-foreground truncate font-mono">{primary}</span>
    );
  }
  const countLabel = labels.moreCount.replace(
    "{count}",
    String(endpoint.extras),
  );
  const isPortList = endpoint.overflowKind === "port";
  const title = isPortList ? labels.morePortsTitle : labels.moreAddressesTitle;
  const countTemplate = isPortList
    ? labels.morePortsCount
    : labels.moreAddressesCount;
  const entries = endpoint.overflowEntries;
  return (
    <span className="flex min-w-0 items-center gap-1 font-mono">
      <span className="text-foreground truncate">{primary}</span>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="focus-visible:ring-ring text-muted-foreground hover:text-foreground pointer-events-auto relative z-10 shrink-0 rounded-sm px-1 text-xs underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:outline-none"
          >
            {countLabel}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72">
          <p className="text-foreground text-xs font-medium">{title}</p>
          <p className="text-muted-foreground text-[10px] uppercase tracking-wide">
            {countTemplate.replace("{count}", String(entries.length))}
          </p>
          {entries.length > 0 ? (
            <ul className="mt-2 max-h-60 overflow-y-auto text-xs font-mono">
              {dedupeKeyedEntries(entries).map(({ entry, key }) => (
                <li
                  key={key}
                  className="border-t border-[var(--sidebar-border)] py-1 first:border-t-0"
                >
                  <OverflowEntryLine
                    entry={entry}
                    side={side}
                    labels={labels}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </PopoverContent>
      </Popover>
    </span>
  );
}

/**
 * One row inside the `+N more` popover. The IP is wrapped in a
 * pivot link (same side-specific template as the primary line) so
 * the overflow addresses — the only place `MultiHostPortScan`,
 * `RdpBruteForce`, and `UnusualDestinationPattern` surface the
 * extra IPs — can be pivoted on, not just the first IP. Port
 * suffix and country decoration stay plain, matching the primary
 * line's rendering.
 */
function OverflowEntryLine({
  entry,
  side,
  labels,
}: {
  entry: OverflowEntry;
  side: "orig" | "resp";
  labels: EventRowLabels;
}) {
  const pivotTemplate =
    side === "orig" ? labels.pivotSourceIp : labels.pivotDestinationIp;
  const href = buildDetectionPivotUrl(
    side === "orig"
      ? { source: entry.ip, window: "1d" }
      : { destination: entry.ip, window: "1d" },
  );
  return (
    <>
      <PivotLink
        href={href}
        aria-label={pivotTemplate.replace("{value}", entry.ip)}
      >
        {entry.ip}
      </PivotLink>
      {entry.portSuffix ? <span>{entry.portSuffix}</span> : null}
      {entry.country ? <span> ({entry.country})</span> : null}
    </>
  );
}

/**
 * Render the first line of an endpoint cell with the IP portion
 * wrapped in a pivot link. Port suffix and country decoration stay
 * plain so only the IP itself is interactive — matching the spec
 * rule that pivotable values render as pivot links while the
 * surrounding row body still opens Quick peek.
 */
function renderPrimary(
  endpoint: ResolvedEndpoint,
  labels: EventRowLabels,
  side: "orig" | "resp",
): React.ReactNode {
  if (!endpoint.primaryIp) {
    return endpoint.primary;
  }
  const pivotTemplate =
    side === "orig" ? labels.pivotSourceIp : labels.pivotDestinationIp;
  const href = buildDetectionPivotUrl(
    side === "orig"
      ? { source: endpoint.primaryIp, window: "1d" }
      : { destination: endpoint.primaryIp, window: "1d" },
  );
  return (
    <>
      <PivotLink
        href={href}
        aria-label={pivotTemplate.replace("{value}", endpoint.primaryIp)}
      >
        {endpoint.primaryIp}
      </PivotLink>
      {endpoint.primaryPortSuffix ? (
        <span>{endpoint.primaryPortSuffix}</span>
      ) : null}
      {endpoint.primaryCountry ? (
        <span> ({endpoint.primaryCountry})</span>
      ) : null}
    </>
  );
}

/**
 * Pivot link used inside the row. Lives above the row-level Quick
 * peek overlay via `pointer-events-auto relative z-10` so clicking
 * the link navigates to the pivoted Detection URL without bubbling
 * into the Quick peek trigger. The surrounding row body still opens
 * Quick peek on click — the only exceptions are these pivot links
 * (and the endpoint `+N more` popover / Investigation button, which
 * already lift themselves above the overlay the same way).
 */
function PivotLink({
  href,
  children,
  className,
  "aria-label": ariaLabel,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <Link
      href={href}
      aria-label={ariaLabel}
      className={`focus-visible:ring-ring text-foreground pointer-events-auto relative z-10 rounded-sm hover:underline focus-visible:ring-2 focus-visible:outline-none ${className ?? ""}`.trim()}
    >
      {children}
    </Link>
  );
}

function pickFirst(
  singular: string | undefined,
  plural: string[] | undefined,
): string | null {
  if (singular) return singular;
  if (Array.isArray(plural) && plural.length > 0 && plural[0]) return plural[0];
  return null;
}

function pickFirstNumber(plural: number[] | undefined): number | undefined {
  if (Array.isArray(plural) && plural.length > 0) return plural[0];
  return undefined;
}

function extraCount(plural: unknown): number {
  if (!Array.isArray(plural) || plural.length <= 1) return 0;
  return plural.length - 1;
}

function formatPort(port: number | undefined): string {
  if (port === undefined || port === null || !Number.isFinite(port)) return "";
  return `:${port}`;
}

function readString(event: EventBase | Event, key: string): string | null {
  const v = (event as unknown as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function summariseTriage(
  event: EventBase | Event,
): { count: number; maxLabel: string } | null {
  const scores = event.triageScores;
  if (!scores || scores.length === 0) return null;
  const max = Math.max(...scores.map((s) => s.score));
  return { count: scores.length, maxLabel: max.toFixed(2) };
}

function humaniseCategory(category: string, labels: EventRowLabels): string {
  return labels.categoryLabels[category as ThreatCategory] ?? category;
}

/**
 * Pure helper exported for tests: collapses an event into the row
 * shape (severity, time, source, destination) without rendering.
 * Lets the row contract be tested without DOM mounting.
 */
export interface EventRowSummary {
  level: ThreatLevel;
  time: string;
  kind: string;
  attackKind: string | null;
  category: string | null;
  confidence: string;
  triage: { count: number; maxLabel: string } | null;
  source: string;
  destination: string;
  sensor: string;
}

export function summariseEvent(
  event: Event,
  labels: EventRowLabels,
): EventRowSummary {
  return {
    level: event.level,
    time: event.time,
    kind: EVENT_KIND_FRIENDLY_NAMES[event.__typename] ?? event.__typename,
    attackKind: readString(event, "attackKind"),
    category: event.category ? humaniseCategory(event.category, labels) : null,
    confidence: event.confidence.toFixed(2),
    triage: summariseTriage(event),
    source: describeEndpoint(event, "orig", labels),
    destination: describeEndpoint(event, "resp", labels),
    sensor: event.sensor,
  };
}

/**
 * String-only endpoint summary, kept for tests. Matches the primary
 * text rendered by `EndpointCell` and appends `+N more` for array
 * fields. The DOM renderer splits the `+N more` into its own
 * popover trigger — this helper flattens it back into a single
 * string for snapshot assertions.
 */
export function describeEndpoint(
  event: EventBase | Event,
  side: "orig" | "resp",
  labels: EventRowLabels,
): string {
  const resolved = resolveEndpoint(event, side, labels);
  if (resolved.extras > 0) {
    const countLabel = labels.moreCount.replace(
      "{count}",
      String(resolved.extras),
    );
    return `${resolved.primary} ${countLabel}`;
  }
  return resolved.primary;
}
