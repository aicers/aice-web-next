/**
 * Shareable URL encoding for the Detection page's active-tab Filter.
 *
 * Phase Detection-10's persistence split (see `tabs.ts`) requires the
 * URL to round-trip the abstract {@link Filter} shape — both
 * `mode: "structured"` (every `EventListFilterInput` field) and the
 * future `mode: "query"` branch — alongside the committed period, the
 * rich endpoint entries, and the URL-only pivot extras (origPort,
 * respPort, proto). The legacy pivot URL params (`source=`, `kind=`,
 * `window=`, etc.) only cover a subset of `EventListFilterInput` and
 * have no representation for `mode: "query"`, levels, countries,
 * learning methods, categories, directions, confidence bounds,
 * sensors, or endpoints — so a reload would silently drop those fields
 * from the active tab.
 *
 * The encoding is a single `?f=<base64url-json>` param that carries
 * the full Filter blob. The legacy pivot params are still parsed when
 * `?f=` is absent so Investigation handoff links of the shape
 * `/detection?source=X&window=1d&kind=HttpThreat` keep working as
 * inbound bootstraps; on the next state mutation (Apply / chip × /
 * tab switch) the URL writer flips over to `?f=` and clears the
 * legacy fields.
 */

import type { EndpointEntry } from "./endpoint-filter";
import type { Filter } from "./filter";
import { PERIOD_KEYS, type PeriodKey } from "./period";
import type {
  EndpointInput,
  EventListFilterInput,
  FlowKind,
  HostNetworkGroupInput,
  IpRangeInput,
  LearningMethod,
  TrafficDirection,
} from "./types";
import type { PivotFilterParams } from "./url-filters";

/** URL search-param key for the encoded filter blob. */
export const FILTER_URL_PARAM = "f";

/**
 * Schema version tag baked into every encoded payload. A deserializer
 * that sees a different version drops the payload rather than
 * attempting an in-place migration; the page falls back to the legacy
 * pivot-param parser, which downgrades the active tab to its default
 * filter rather than crashing.
 */
const PAYLOAD_VERSION = 1 as const;

/**
 * Pivot-only fields that survive in the URL even though they have no
 * filter-drawer source yet (Phase Network/IP will wire them in). Kept
 * as a narrow shape so the encoded payload never carries the
 * filter-derived `kind` / `window` / source-of-truth fields again —
 * those round-trip through the {@link Filter} blob.
 */
export interface PivotExtras {
  origPort?: number;
  respPort?: number;
  proto?: number;
}

export interface EncodedTabFilter {
  filter: Filter;
  period: PeriodKey | null;
  endpoints: EndpointEntry[];
  pivotExtras: PivotExtras;
}

interface PayloadV1 extends EncodedTabFilter {
  v: typeof PAYLOAD_VERSION;
}

/**
 * Encode the active tab's filter state into a base64url JSON blob
 * suitable for a single URL search param. Uses base64url so the
 * result stays inside the URL-safe character class without any
 * percent-encoding overhead.
 */
export function serializeFilterToUrlParam(args: EncodedTabFilter): string {
  const payload: PayloadV1 = {
    v: PAYLOAD_VERSION,
    filter: args.filter,
    period: args.period,
    endpoints: args.endpoints,
    pivotExtras: pickPivotExtras(args.pivotExtras),
  };
  return base64UrlEncode(JSON.stringify(payload));
}

/**
 * Decode a `?f=` param. Returns `null` when the value is absent,
 * malformed, or carries an unknown version — callers fall back to the
 * legacy pivot-param parser in that case.
 *
 * Reviewer Round 6 (item 2): the decoder deep-validates the
 * structured filter shape rather than handing the raw object straight
 * through. `?f=` is shareable URL input, so any caller can craft a
 * malformed payload — for example
 * `{filter: {mode: "structured", input: {categories: "not-an-array"}}}`
 * — that previously passed the shallow `mode + input` check and then
 * crashed later when chip / draft helpers called array methods on the
 * coerced field. The coercion below drops every field that does not
 * match the {@link EventListFilterInput} contract so the worst a bad
 * link can do is silently downgrade to the default filter, never
 * throw inside a render.
 */
export function parseFilterFromUrlParam(
  raw: string | null | undefined,
): EncodedTabFilter | null {
  if (!raw) return null;
  let json: string;
  try {
    json = base64UrlDecode(raw);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isPayloadV1(parsed)) return null;
  const filter = coerceFilter(parsed.filter);
  if (!filter) return null;
  return {
    filter,
    period: coercePeriodKey(parsed.period),
    endpoints: coerceEndpointEntries(parsed.endpoints),
    pivotExtras: pickPivotExtras(parsed.pivotExtras ?? {}),
  };
}

/**
 * URL search-param keys the legacy pivot-param encoder writes — kept
 * here so the new `?f=` writer can clear them in one shot when it
 * takes over the URL. Stale legacy fields would otherwise survive
 * alongside the new blob and confuse a downstream `?f=`-aware reader
 * into thinking the URL carries two filters.
 */
export const LEGACY_FILTER_PARAM_KEYS: readonly string[] = [
  "source",
  "destination",
  "kind",
  "origPort",
  "respPort",
  "proto",
  "window",
  "keywords",
  "hostnames",
  "userIds",
  "userNames",
  "userDepartments",
];

/**
 * Drop every legacy filter param from the supplied search object.
 * Used by the URL writer right before it sets the new `?f=` blob so
 * the URL stays canonical regardless of the inbound URL shape.
 */
export function clearLegacyFilterParams(search: URLSearchParams): void {
  for (const key of LEGACY_FILTER_PARAM_KEYS) search.delete(key);
}

function pickPivotExtras(value: unknown): PivotExtras {
  if (!value || typeof value !== "object") return {};
  const v = value as Record<string, unknown>;
  const out: PivotExtras = {};
  if (typeof v.origPort === "number" && Number.isFinite(v.origPort)) {
    out.origPort = v.origPort;
  }
  if (typeof v.respPort === "number" && Number.isFinite(v.respPort)) {
    out.respPort = v.respPort;
  }
  if (typeof v.proto === "number" && Number.isFinite(v.proto)) {
    out.proto = v.proto;
  }
  return out;
}

function isPayloadV1(value: unknown): value is PayloadV1 {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<PayloadV1>;
  if (v.v !== PAYLOAD_VERSION) return false;
  if (!isFilter(v.filter)) return false;
  if (
    v.period !== null &&
    typeof v.period !== "string" &&
    v.period !== undefined
  ) {
    return false;
  }
  return true;
}

function isFilter(value: unknown): value is Filter {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<Filter>;
  if (v.mode === "structured") {
    return (
      !!(v as { input?: unknown }).input &&
      typeof (v as { input?: unknown }).input === "object"
    );
  }
  if (v.mode === "query") {
    return typeof (v as { text?: unknown }).text === "string";
  }
  return false;
}

/**
 * Reviewer Round 6 (item 2): coerce a parsed `?f=` payload's filter
 * field into a strict {@link Filter}. The shallow `isFilter` check
 * only verifies `mode` and that `input` is an object — it would
 * happily pass `{ categories: "not-an-array" }` straight through to
 * the chip / draft helpers, where `.filter(...)` on a string then
 * throws inside the render. The coercion below walks every
 * `EventListFilterInput` field and drops any that does not match the
 * generated schema's type. Returns `null` only when the outer shape
 * is unrecoverable (unknown mode, missing query text); a structured
 * filter with all fields stripped is still a valid filter.
 */
function coerceFilter(value: unknown): Filter | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { mode?: unknown; input?: unknown; text?: unknown };
  if (v.mode === "structured") {
    if (!v.input || typeof v.input !== "object") return null;
    return {
      mode: "structured",
      input: coerceEventListFilterInput(v.input),
    };
  }
  if (v.mode === "query") {
    if (typeof v.text !== "string") return null;
    return { mode: "query", text: v.text };
  }
  return null;
}

const FLOW_KIND_VALUES = new Set<FlowKind>(["INBOUND", "OUTBOUND", "INTERNAL"]);
const LEARNING_METHOD_VALUES = new Set<LearningMethod>([
  "UNSUPERVISED",
  "SEMI_SUPERVISED",
]);
const TRAFFIC_DIRECTION_VALUES = new Set<TrafficDirection>(["FROM", "TO"]);

function coerceEventListFilterInput(value: object): EventListFilterInput {
  const v = value as Record<string, unknown>;
  const out: EventListFilterInput = {};
  if (typeof v.start === "string") out.start = v.start;
  if (typeof v.end === "string") out.end = v.end;
  if (typeof v.source === "string") out.source = v.source;
  if (typeof v.destination === "string") out.destination = v.destination;
  const stringArrayFields = [
    "customers",
    "keywords",
    "networkTags",
    "sensors",
    "os",
    "devices",
    "hostnames",
    "userIds",
    "userNames",
    "userDepartments",
    "countries",
    "kinds",
    "triagePolicies",
  ] as const;
  for (const key of stringArrayFields) {
    const arr = filterStringArray(v[key]);
    if (arr) out[key] = arr;
  }
  const numberArrayFields = ["levels"] as const;
  for (const key of numberArrayFields) {
    const arr = filterNumberArray(v[key]);
    if (arr) out[key] = arr;
  }
  if (Array.isArray(v.categories)) {
    out.categories = v.categories.filter(
      (item): item is number | null =>
        item === null || typeof item === "number",
    );
  }
  if (Array.isArray(v.directions)) {
    out.directions = v.directions.filter(
      (item): item is FlowKind =>
        typeof item === "string" && FLOW_KIND_VALUES.has(item as FlowKind),
    );
  }
  if (Array.isArray(v.learningMethods)) {
    out.learningMethods = v.learningMethods.filter(
      (item): item is LearningMethod =>
        typeof item === "string" &&
        LEARNING_METHOD_VALUES.has(item as LearningMethod),
    );
  }
  if (typeof v.confidenceMin === "number" && Number.isFinite(v.confidenceMin)) {
    out.confidenceMin = v.confidenceMin;
  }
  if (typeof v.confidenceMax === "number" && Number.isFinite(v.confidenceMax)) {
    out.confidenceMax = v.confidenceMax;
  }
  if (Array.isArray(v.endpoints)) {
    const eps = v.endpoints
      .map(coerceEndpointInput)
      .filter((ep): ep is EndpointInput => ep !== null);
    if (eps.length > 0) out.endpoints = eps;
  }
  return out;
}

function filterStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string");
}

function filterNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter(
    (item): item is number => typeof item === "number" && Number.isFinite(item),
  );
}

function coerceEndpointInput(value: unknown): EndpointInput | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const out: EndpointInput = {};
  if (
    typeof v.direction === "string" &&
    TRAFFIC_DIRECTION_VALUES.has(v.direction as TrafficDirection)
  ) {
    out.direction = v.direction as TrafficDirection;
  } else if (v.direction === null) {
    out.direction = null;
  }
  if (typeof v.predefined === "string") out.predefined = v.predefined;
  const custom = coerceHostNetworkGroup(v.custom);
  if (custom) out.custom = custom;
  return out;
}

function coerceHostNetworkGroup(value: unknown): HostNetworkGroupInput | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return {
    hosts: filterStringArray(v.hosts) ?? [],
    networks: filterStringArray(v.networks) ?? [],
    ranges: Array.isArray(v.ranges)
      ? v.ranges.map(coerceIpRange).filter((r): r is IpRangeInput => r !== null)
      : [],
  };
}

function coerceIpRange(value: unknown): IpRangeInput | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.start !== "string" || typeof v.end !== "string") return null;
  return { start: v.start, end: v.end };
}

function coercePeriodKey(value: unknown): PeriodKey | null {
  if (typeof value !== "string") return null;
  return PERIOD_KEYS.includes(value as PeriodKey) ? (value as PeriodKey) : null;
}

/**
 * Coerce the raw `endpoints` array on the payload into a clean
 * {@link EndpointEntry}[] — these are the rich client-side entries
 * that drive the Network/IP advanced panel, distinct from the
 * generated `EndpointInput[]` that ship inside `filter.input`.
 */
function coerceEndpointEntries(value: unknown): EndpointEntry[] {
  if (!Array.isArray(value)) return [];
  const out: EndpointEntry[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const c = candidate as Record<string, unknown>;
    if (typeof c.id !== "string") continue;
    if (typeof c.raw !== "string") continue;
    if (c.kind !== "host" && c.kind !== "range" && c.kind !== "network") {
      continue;
    }
    if (
      c.direction !== "BOTH" &&
      c.direction !== "SOURCE" &&
      c.direction !== "DESTINATION"
    ) {
      continue;
    }
    if (typeof c.selected !== "boolean") continue;
    const entry: EndpointEntry = {
      id: c.id,
      raw: c.raw,
      kind: c.kind,
      direction: c.direction,
      selected: c.selected,
    };
    if (c.kind === "host" && typeof c.host === "string") entry.host = c.host;
    if (c.kind === "network" && typeof c.network === "string") {
      entry.network = c.network;
    }
    if (c.kind === "range") {
      const range = coerceIpRange(c.range);
      if (range) entry.range = range;
    }
    out.push(entry);
  }
  return out;
}

function base64UrlEncode(input: string): string {
  // Use TextEncoder + btoa for a Unicode-safe base64. Plain `btoa`
  // throws on multi-byte chars (e.g. KR labels in a saved query).
  const bytes = new TextEncoder().encode(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(input: string): string {
  const padded = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    // base64 requires length divisible by 4; reattach `=` padding.
    .padEnd(input.length + ((4 - (input.length % 4)) % 4), "=");
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Construct a fresh `URLSearchParams` carrying just the `?f=` blob
 * for the supplied filter state. Callers layer pagination, tab id,
 * and quick-peek params on top of the returned object — see
 * `DetectionTabsShell.buildUrlSearchForTab` and
 * `DetectionShell.handleApply`.
 */
export function buildSearchParamsForFilter(
  args: EncodedTabFilter,
): URLSearchParams {
  const search = new URLSearchParams();
  search.set(FILTER_URL_PARAM, serializeFilterToUrlParam(args));
  return search;
}

/**
 * Convenience helper for callers that already have an
 * `EventListFilterInput` and want the wrapping `Filter` shape.
 */
export function structuredFilter(input: EventListFilterInput): Filter {
  return { mode: "structured", input };
}

/**
 * Lift the URL-only pivot params (origPort, respPort, proto) out of a
 * legacy-style `PivotFilterParams` object — used when the page is
 * bootstrapping from an Investigation handoff URL and we want the
 * pivot-only fields preserved into the encoded `?f=` blob on the next
 * state mutation.
 */
export function pivotExtrasFromPivotParams(
  params: PivotFilterParams,
): PivotExtras {
  const out: PivotExtras = {};
  if (params.origPort !== undefined) out.origPort = params.origPort;
  if (params.respPort !== undefined) out.respPort = params.respPort;
  if (params.proto !== undefined) out.proto = params.proto;
  return out;
}
