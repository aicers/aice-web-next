/**
 * Client-side model for the Network/IP advanced filter. Each
 * `EndpointEntry` is a row the operator builds in the Custom
 * section; `endpointsToEndpointInputs()` translates the visible
 * rows into the `endpoints: [EndpointInput!]` array that
 * `EventListFilterInput` accepts.
 *
 * The three accepted input formats — single IP, IP range, CIDR —
 * are parsed by `parseEndpointInput()` and routed into the
 * `custom.hosts`, `custom.ranges`, `custom.networks` buckets.
 */
import type { EndpointInput, IpRangeInput, TrafficDirection } from "./types";

/**
 * Direction stored on each custom entry. Standardized long-form —
 * never abbreviate to `SRC` / `DST` in user-facing strings. `BOTH`
 * serializes to `direction: null` on submit.
 */
export type EndpointEntryDirection = "BOTH" | "SOURCE" | "DESTINATION";

export type EndpointEntryKind = "host" | "range" | "network";

export interface EndpointEntry {
  id: string;
  /** Original text the operator typed; kept for display + re-parsing. */
  raw: string;
  kind: EndpointEntryKind;
  /** Populated when `kind === "host"`. */
  host?: string;
  /** Populated when `kind === "network"`. */
  network?: string;
  /** Populated when `kind === "range"`. */
  range?: IpRangeInput;
  direction: EndpointEntryDirection;
  /** Deselected entries are de-emphasized and omitted on submit. */
  selected: boolean;
}

export interface ParsedEndpoint {
  kind: EndpointEntryKind;
  host?: string;
  network?: string;
  range?: IpRangeInput;
}

/**
 * Parse a raw input string into one of the three accepted formats.
 * Returns `null` if the text matches none of them; the caller
 * surfaces the inline error with the three documented examples.
 *
 * Accepted:
 * - `10.84.1.7` → `{ kind: "host" }`
 * - `10.1.1.1 - 10.1.1.20` → `{ kind: "range" }`
 * - `192.168.10.0/24` → `{ kind: "network" }`
 *
 * Only IPv4 is accepted in v1. Whitespace around the hyphen in an
 * IP range is ignored.
 */
export function parseEndpointInput(input: string): ParsedEndpoint | null {
  const text = input.trim();
  if (!text) return null;

  // Range: two IPv4s separated by a hyphen. Check before single-IP
  // so a string like `1.2.3.4 - 5.6.7.8` does not short-circuit to
  // the single-IP branch on its prefix.
  if (text.includes("-")) {
    const [left, right, ...rest] = text.split("-");
    if (rest.length > 0) return null;
    const start = left?.trim() ?? "";
    const end = right?.trim() ?? "";
    if (isIpv4(start) && isIpv4(end)) {
      if (!ipv4LessOrEqual(start, end)) return null;
      return { kind: "range", range: { start, end } };
    }
    return null;
  }

  // CIDR: `address/prefix`, prefix in [0, 32].
  if (text.includes("/")) {
    const [addr, prefix, ...rest] = text.split("/");
    if (rest.length > 0 || addr === undefined || prefix === undefined) {
      return null;
    }
    if (!isIpv4(addr)) return null;
    if (!/^\d+$/.test(prefix)) return null;
    const bits = Number.parseInt(prefix, 10);
    if (bits < 0 || bits > 32) return null;
    return { kind: "network", network: `${addr}/${bits}` };
  }

  // Single IPv4.
  if (isIpv4(text)) return { kind: "host", host: text };
  return null;
}

function isIpv4(text: string): boolean {
  const parts = text.split(".");
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return false;
    // Reject leading zeros except the single digit `0` — they often
    // signal a typo rather than octal intent.
    if (p.length > 1 && p.startsWith("0")) return false;
    const n = Number.parseInt(p, 10);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

function ipv4LessOrEqual(a: string, b: string): boolean {
  return ipv4ToNumber(a) <= ipv4ToNumber(b);
}

function ipv4ToNumber(text: string): number {
  const parts = text.split(".").map((p) => Number.parseInt(p, 10));
  // Avoid `<<` on the top octet — shifting 24 positions on a
  // 32-bit signed int flips the sign. Multiply instead.
  return (
    (parts[0] ?? 0) * 0x01000000 +
    ((parts[1] ?? 0) << 16) +
    ((parts[2] ?? 0) << 8) +
    (parts[3] ?? 0)
  );
}

/**
 * Translate custom entries into the `endpoints` array the BFF
 * forwards to REview. Deselected entries are skipped. Entries are
 * grouped by direction so the submitted array contains at most one
 * `EndpointInput` per direction (`FROM`, `TO`, `null`) — REview
 * accepts either shape, and grouping keeps the wire payload tight.
 */
export function endpointsToEndpointInputs(
  entries: EndpointEntry[],
): EndpointInput[] {
  const buckets = new Map<
    EndpointEntryDirection,
    { hosts: string[]; networks: string[]; ranges: IpRangeInput[] }
  >();

  for (const entry of entries) {
    if (!entry.selected) continue;
    let bucket = buckets.get(entry.direction);
    if (!bucket) {
      bucket = { hosts: [], networks: [], ranges: [] };
      buckets.set(entry.direction, bucket);
    }
    if (entry.kind === "host" && entry.host) {
      bucket.hosts.push(entry.host);
    } else if (entry.kind === "network" && entry.network) {
      bucket.networks.push(entry.network);
    } else if (entry.kind === "range" && entry.range) {
      bucket.ranges.push(entry.range);
    }
  }

  const result: EndpointInput[] = [];
  // Stable ordering so the submitted payload (and snapshot tests)
  // don't flutter with Map insertion order.
  const order: EndpointEntryDirection[] = ["BOTH", "SOURCE", "DESTINATION"];
  for (const dir of order) {
    const bucket = buckets.get(dir);
    if (!bucket) continue;
    if (
      bucket.hosts.length === 0 &&
      bucket.networks.length === 0 &&
      bucket.ranges.length === 0
    ) {
      continue;
    }
    result.push({
      direction: toTrafficDirection(dir),
      custom: {
        hosts: bucket.hosts,
        networks: bucket.networks,
        ranges: bucket.ranges,
      },
    });
  }
  return result;
}

function toTrafficDirection(
  dir: EndpointEntryDirection,
): TrafficDirection | null {
  if (dir === "SOURCE") return "FROM";
  if (dir === "DESTINATION") return "TO";
  return null;
}

export interface EndpointChipLabels {
  /** Short prefix for a SOURCE entry (e.g. `Src`). */
  source: string;
  /** Short prefix for a DESTINATION entry (e.g. `Dst`). */
  destination: string;
  /** Aggregate label template; accepts `{count}` placeholder. */
  aggregate: string;
}

export interface EndpointChip {
  id: string;
  label: string;
  /** Aggregate chip when more than the per-entry threshold is hit. */
  aggregate: boolean;
}

export const ENDPOINT_CHIP_AGGREGATE_THRESHOLD = 3;

/**
 * Build the chip list for the active filter bar.
 *
 * - 0 entries → empty list (the bar falls back to its own empty
 *   state).
 * - 1–3 entries → one chip per entry, each summarizing direction +
 *   the original text.
 * - More than 3 → one aggregate chip (`Network: N rules`).
 */
export function buildEndpointChips(
  entries: EndpointEntry[],
  labels: EndpointChipLabels,
): EndpointChip[] {
  const selected = entries.filter((e) => e.selected);
  if (selected.length === 0) return [];
  if (selected.length > ENDPOINT_CHIP_AGGREGATE_THRESHOLD) {
    return [
      {
        id: "endpoint-aggregate",
        label: labels.aggregate.replace("{count}", String(selected.length)),
        aggregate: true,
      },
    ];
  }
  return selected.map((entry) => {
    let prefix = "";
    if (entry.direction === "SOURCE") prefix = `${labels.source} `;
    else if (entry.direction === "DESTINATION")
      prefix = `${labels.destination} `;
    return {
      id: entry.id,
      label: `${prefix}${entry.raw}`,
      aggregate: false,
    };
  });
}

/**
 * Generate a stable id for a new entry. Uses a monotonic counter
 * seeded from `Date.now()` so a duplicate removal+add in the same
 * millisecond doesn't collide; the React list key only needs to be
 * stable within the current session.
 */
let idCounter = 0;
export function createEndpointEntryId(): string {
  idCounter += 1;
  return `endpoint-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}
