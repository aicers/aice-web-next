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
import type { Event, EventBase, ThreatLevel } from "@/lib/detection/types";
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
  // Host-based subtypes (`ExtraThreat`, `WindowsThreat`) carry no
  // source/destination addressing, so the locator token cannot be
  // built for them. Hide the "Open investigation" affordance in that
  // case rather than rendering a dead button that silently no-ops
  // when clicked — the contract is "a dedicated affordance opens
  // Investigation view", not "a button that pretends to".
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
          <span className="text-foreground truncate text-sm font-medium">
            {friendlyKind}
          </span>
          {attackKind ? (
            // `pointer-events-auto` so the native hover tooltip
            // (`title`) still fires on medium viewports where the
            // `attackKind` string is truncated with ellipsis. Without
            // this, the ancestor's `pointer-events-none` suppresses
            // hover entirely, breaking the required tooltip. The
            // explicit click handler forwards activation to the row
            // overlay so clicking the text still opens Quick peek.
            <button
              type="button"
              onClick={() => onSelect?.(event)}
              title={attackKind}
              className="text-muted-foreground pointer-events-auto relative z-10 truncate bg-transparent text-left text-xs"
            >
              {labels.attackKindLabel.replace("{kind}", attackKind)}
            </button>
          ) : null}
          {event.category ? (
            <span className="text-muted-foreground hidden text-xs sm:inline">
              {humaniseCategory(event.category)}
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
          <EndpointCell endpoint={source} labels={labels} />
          <ArrowRight
            className="hidden size-3 sm:inline-block"
            aria-hidden="true"
          />
          <EndpointCell endpoint={destination} labels={labels} />
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
 * Structured endpoint result: the visible primary line plus the
 * optional overflow set for the `+N more` popover. Split out so the
 * row can render the popover affordance itself — the inline `+N
 * more` was previously a plain string with no way for the operator
 * to inspect the hidden values.
 */
export interface ResolvedEndpoint {
  /** `10.0.0.5:443 (US)` — the first-entry decoration. */
  primary: string;
  /** Overflow collection kind, or null when there is no overflow. */
  overflowKind: OverflowKind | null;
  /**
   * Fully-formatted popover entries. Address arrays produce
   * `ip[:port] (country)` per entry (per-index country + shared port);
   * port arrays produce `ip:port (country)` (shared ip + country +
   * per-entry port). Empty when the endpoint has no overflow.
   */
  overflowEntries: readonly string[];
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
  let overflowEntries: string[] = [];
  if (Array.isArray(addrArray) && addrArray.length > 0) {
    overflowKind = "address";
    overflowEntries = addrArray.map((entryAddr, index) => {
      const entryCountry = Array.isArray(countryArray)
        ? countryArray[index]
        : country;
      return formatEntry(entryAddr, sharedPort, entryCountry ?? null);
    });
  } else if (Array.isArray(portArray) && portArray.length > 0) {
    overflowKind = "port";
    overflowEntries = portArray.map((entryPort) =>
      formatEntry(addr, entryPort, country ?? null),
    );
  }

  return {
    primary,
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
}: {
  endpoint: ResolvedEndpoint;
  labels: EventRowLabels;
}) {
  if (endpoint.extras <= 0) {
    return (
      <span className="text-foreground truncate font-mono">
        {endpoint.primary}
      </span>
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
      <span className="text-foreground truncate">{endpoint.primary}</span>
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
              {entries.map((value) => (
                <li
                  key={value}
                  className="border-t border-[var(--sidebar-border)] py-1 first:border-t-0"
                >
                  {value}
                </li>
              ))}
            </ul>
          ) : null}
        </PopoverContent>
      </Popover>
    </span>
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

const CATEGORY_LABELS: Record<string, string> = {
  RECONNAISSANCE: "Reconnaissance",
  INITIAL_ACCESS: "Initial Access",
  EXECUTION: "Execution",
  CREDENTIAL_ACCESS: "Credential Access",
  DISCOVERY: "Discovery",
  LATERAL_MOVEMENT: "Lateral Movement",
  COMMAND_AND_CONTROL: "Command & Control",
  EXFILTRATION: "Exfiltration",
  IMPACT: "Impact",
  COLLECTION: "Collection",
  DEFENSE_EVASION: "Defense Evasion",
  PERSISTENCE: "Persistence",
  PRIVILEGE_ESCALATION: "Privilege Escalation",
  RESOURCE_DEVELOPMENT: "Resource Development",
};

function humaniseCategory(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
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
    category: event.category ? humaniseCategory(event.category) : null,
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
