/**
 * Filter normalization and identity comparison (Phase Detection-12).
 *
 * The pivot logic in {@link openPivotTab} needs a way to ask
 * "does any tab already carry this exact filter?" — so a click on
 * an `origAddr` cell that would only re-narrow the active tab is
 * routed to a toast instead of producing a duplicate tab. The same
 * helper backs the cross-tab focus path: when a non-active tab's
 * normalized filter equals the target, that tab is activated rather
 * than a new one being created.
 *
 * Normalization rules:
 *
 * - Array fields (`kinds`, `levels`, `categories`, `countries`,
 *   `directions`, `learningMethods`, `keywords`, `hostnames`,
 *   `userIds`, `userNames`, `userDepartments`, `sensors`,
 *   `customers`, `networkTags`, `os`, `devices`, `triagePolicies`)
 *   are sorted (numeric for `levels` / `categories`, lexicographic
 *   for the rest) and deduplicated. Empty arrays drop out. Reviewer
 *   Round 1: every schema-backed `EventListFilterInput` field is
 *   represented so two tabs that differ only by `customers`,
 *   `networkTags`, `os`, `devices`, or `triagePolicies` are not
 *   collapsed together by the pivot toast / focus path.
 * - `endpoints[]` is normalized by sorting each
 *   `HostNetworkGroupInput.hosts` / `networks` and each
 *   `IpRangeInput` tuple, ordering the entries by `direction`
 *   (FROM → TO → null), and (Reviewer Round 1) carrying through
 *   `EndpointInput.predefined` so two tabs that differ only by the
 *   referenced predefined network compare unequal. Empty entries
 *   are dropped.
 * - Scalar string fields (`source`, `destination`) drop when empty.
 * - Numeric bounds (`confidenceMin` / `confidenceMax`) drop when
 *   undefined.
 * - Time identity: when {@link FilterIdentityInput.period} is
 *   non-null the period key replaces the literal `start` / `end`
 *   pair so two tabs with the same relative window (e.g. "Last 1
 *   hour") compare equal even though their ISO timestamps drift
 *   apart between renders. When the period is null we fall back
 *   to the ISO `start` / `end` pair verbatim.
 *
 * The result of {@link normalizeFilterIdentity} is a deterministic
 * JSON string suitable for `===` comparison; downstream callers
 * should not parse it back — its shape is intentionally opaque so
 * we can change the canonicalization without churning every call
 * site.
 */

import type { Filter } from "./filter";
import type { PeriodKey } from "./period";
import type {
  EndpointInput,
  EventListFilterInput,
  FlowKind,
  IpRangeInput,
  LearningMethod,
  TrafficDirection,
} from "./types";

export interface FilterIdentityInput {
  filter: Filter;
  /**
   * Committed period key when the operator chose a relative window
   * ("Last 1 hour", etc.). `null` falls back to comparing the literal
   * ISO `start` / `end` pair on the structured filter.
   */
  period: PeriodKey | null;
}

/**
 * Canonical opaque identity string for a (filter, period) pair.
 * Two pairs that share the same identity are interchangeable for
 * the multi-tab "is this filter already represented?" decision.
 */
export type FilterIdentity = string;

const FLOW_ORDER: Record<FlowKind, number> = {
  OUTBOUND: 0,
  INTERNAL: 1,
  INBOUND: 2,
};

const TRAFFIC_DIRECTION_ORDER: Record<string, number> = {
  FROM: 0,
  TO: 1,
  // `null` direction sorts last so two endpoint payloads that share
  // the same hosts list under FROM / null compare consistently.
  __null__: 2,
};

const LEARNING_METHOD_ORDER: Record<LearningMethod, number> = {
  UNSUPERVISED: 0,
  SEMI_SUPERVISED: 1,
};

/**
 * Produce the opaque identity string used by {@link filterIdentitiesEqual}.
 * `mode: "query"` filters compare by the literal trimmed text — the
 * search-language editor lands in a later phase and v1 has no other
 * way to canonicalise free-form query text.
 */
export function normalizeFilterIdentity(
  args: FilterIdentityInput,
): FilterIdentity {
  const { filter, period } = args;
  if (filter.mode === "query") {
    return JSON.stringify({ mode: "query", text: filter.text.trim() });
  }
  return JSON.stringify({
    mode: "structured",
    input: normalizeStructuredInput(filter.input, period),
  });
}

export function filterIdentitiesEqual(
  a: FilterIdentity,
  b: FilterIdentity,
): boolean {
  return a === b;
}

/**
 * Convenience wrapper around {@link normalizeFilterIdentity} for the
 * common "are these two pairs interchangeable?" question.
 */
export function filtersAreEquivalent(
  a: FilterIdentityInput,
  b: FilterIdentityInput,
): boolean {
  return normalizeFilterIdentity(a) === normalizeFilterIdentity(b);
}

/**
 * Identity used by the Phase Detection-14 analytics strip's fetch
 * effect and in-memory cache.
 *
 * Intentionally diverges from the multi-tab pivot identity: it always
 * canonicalizes the literal `start` / `end` ISO pair (i.e. `period: null`).
 * Re-applying the same relative period chip — for example clicking
 * `Last 1 hour` again from the drawer — recomputes new ISO bounds
 * and replaces the result-list filter; the open analytics strip must
 * refetch against the new window, so the period-collapsing pivot
 * identity is too lossy here.
 */
export function analyticsFilterIdentity(filter: Filter): FilterIdentity {
  return normalizeFilterIdentity({ filter, period: null });
}

interface NormalizedStructuredInput {
  /** Set when `period` is non-null. Replaces literal start / end. */
  periodKey?: PeriodKey;
  start?: string;
  end?: string;
  source?: string;
  destination?: string;
  keywords?: string[];
  hostnames?: string[];
  userIds?: string[];
  userNames?: string[];
  userDepartments?: string[];
  sensors?: string[];
  customers?: string[];
  networkTags?: string[];
  os?: string[];
  devices?: string[];
  triagePolicies?: string[];
  countries?: string[];
  kinds?: string[];
  levels?: number[];
  categories?: number[];
  learningMethods?: LearningMethod[];
  directions?: FlowKind[];
  endpoints?: NormalizedEndpoint[];
  confidenceMin?: number;
  confidenceMax?: number;
}

interface NormalizedEndpoint {
  direction: TrafficDirection | null;
  /**
   * `EndpointInput.predefined` — id of a server-defined network
   * group. Carried through verbatim so two tabs that select different
   * predefined networks compare unequal even when their `custom`
   * payloads happen to match.
   */
  predefined?: string;
  hosts: string[];
  networks: string[];
  ranges: { start: string; end: string }[];
}

function normalizeStructuredInput(
  input: EventListFilterInput,
  period: PeriodKey | null,
): NormalizedStructuredInput {
  const out: NormalizedStructuredInput = {};

  if (period) {
    out.periodKey = period;
  } else {
    if (input.start) out.start = input.start;
    if (input.end) out.end = input.end;
  }

  if (input.source && input.source.trim().length > 0) {
    out.source = input.source.trim();
  }
  if (input.destination && input.destination.trim().length > 0) {
    out.destination = input.destination.trim();
  }

  setIfNonEmpty(out, "keywords", uniqueSortedStrings(input.keywords));
  setIfNonEmpty(out, "hostnames", uniqueSortedStrings(input.hostnames));
  setIfNonEmpty(out, "userIds", uniqueSortedStrings(input.userIds));
  setIfNonEmpty(out, "userNames", uniqueSortedStrings(input.userNames));
  setIfNonEmpty(
    out,
    "userDepartments",
    uniqueSortedStrings(input.userDepartments),
  );
  setIfNonEmpty(out, "sensors", uniqueSortedStrings(input.sensors));
  setIfNonEmpty(out, "customers", uniqueSortedStrings(input.customers));
  setIfNonEmpty(out, "networkTags", uniqueSortedStrings(input.networkTags));
  setIfNonEmpty(out, "os", uniqueSortedStrings(input.os));
  setIfNonEmpty(out, "devices", uniqueSortedStrings(input.devices));
  setIfNonEmpty(
    out,
    "triagePolicies",
    uniqueSortedStrings(input.triagePolicies),
  );
  setIfNonEmpty(out, "countries", uniqueSortedStrings(input.countries));
  setIfNonEmpty(out, "kinds", uniqueSortedStrings(input.kinds));
  setIfNonEmpty(out, "levels", uniqueSortedNumbers(input.levels));
  setIfNonEmpty(
    out,
    "categories",
    uniqueSortedNumbers(
      (input.categories ?? []).filter(
        (v): v is number => typeof v === "number",
      ),
    ),
  );

  if (input.learningMethods && input.learningMethods.length > 0) {
    const seen = new Set<LearningMethod>();
    const sorted = [...input.learningMethods]
      .filter((v) => {
        if (seen.has(v)) return false;
        seen.add(v);
        return true;
      })
      .sort((a, b) => LEARNING_METHOD_ORDER[a] - LEARNING_METHOD_ORDER[b]);
    if (sorted.length > 0) out.learningMethods = sorted;
  }

  if (input.directions && input.directions.length > 0) {
    const seen = new Set<FlowKind>();
    const sorted = [...input.directions]
      .filter((v) => {
        if (seen.has(v)) return false;
        seen.add(v);
        return true;
      })
      .sort((a, b) => FLOW_ORDER[a] - FLOW_ORDER[b]);
    if (sorted.length > 0) out.directions = sorted;
  }

  if (input.endpoints && input.endpoints.length > 0) {
    const normalized = normalizeEndpoints(input.endpoints);
    if (normalized.length > 0) out.endpoints = normalized;
  }

  if (typeof input.confidenceMin === "number") {
    out.confidenceMin = input.confidenceMin;
  }
  if (typeof input.confidenceMax === "number") {
    out.confidenceMax = input.confidenceMax;
  }

  return out;
}

function normalizeEndpoints(entries: EndpointInput[]): NormalizedEndpoint[] {
  const out: NormalizedEndpoint[] = [];
  for (const entry of entries) {
    const custom = entry.custom ?? null;
    const hosts = custom ? (uniqueSortedStrings(custom.hosts) ?? []) : [];
    const networks = custom ? (uniqueSortedStrings(custom.networks) ?? []) : [];
    const ranges = custom ? normalizeRanges(custom.ranges) : [];
    const predefined =
      typeof entry.predefined === "string" && entry.predefined.length > 0
        ? entry.predefined
        : undefined;
    // Reviewer Round 1: a predefined-only endpoint (no custom payload)
    // is a valid filter slot — keep it instead of dropping it on the
    // floor like the prior shape did. The "drop empties" rule only
    // applies when the entry carries no information at all.
    if (
      hosts.length === 0 &&
      networks.length === 0 &&
      ranges.length === 0 &&
      !predefined
    ) {
      continue;
    }
    const normalized: NormalizedEndpoint = {
      direction: entry.direction ?? null,
      hosts,
      networks,
      ranges,
    };
    if (predefined) normalized.predefined = predefined;
    out.push(normalized);
  }
  out.sort((a, b) => {
    const ka = a.direction ?? "__null__";
    const kb = b.direction ?? "__null__";
    const directionOrder =
      (TRAFFIC_DIRECTION_ORDER[ka] ?? 99) - (TRAFFIC_DIRECTION_ORDER[kb] ?? 99);
    if (directionOrder !== 0) return directionOrder;
    // Tiebreak on `predefined` so two same-direction entries that
    // differ only by predefined id sort deterministically.
    const pa = a.predefined ?? "";
    const pb = b.predefined ?? "";
    return pa.localeCompare(pb);
  });
  return out;
}

function normalizeRanges(
  ranges: IpRangeInput[] | undefined,
): { start: string; end: string }[] {
  if (!ranges || ranges.length === 0) return [];
  const seen = new Set<string>();
  const out: { start: string; end: string }[] = [];
  for (const r of ranges) {
    const key = `${r.start}|${r.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ start: r.start, end: r.end });
  }
  out.sort((a, b) =>
    a.start === b.start
      ? a.end.localeCompare(b.end)
      : a.start.localeCompare(b.start),
  );
  return out;
}

function uniqueSortedStrings(
  values: readonly string[] | null | undefined,
): string[] | undefined {
  if (!values || values.length === 0) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== "string") continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  if (out.length === 0) return undefined;
  out.sort();
  return out;
}

function uniqueSortedNumbers(
  values: readonly number[] | null | undefined,
): number[] | undefined {
  if (!values || values.length === 0) return undefined;
  const seen = new Set<number>();
  const out: number[] = [];
  for (const v of values) {
    if (typeof v !== "number") continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  if (out.length === 0) return undefined;
  out.sort((a, b) => a - b);
  return out;
}

function setIfNonEmpty<K extends keyof NormalizedStructuredInput>(
  out: NormalizedStructuredInput,
  key: K,
  value: NormalizedStructuredInput[K] | undefined,
): void {
  if (value === undefined) return;
  if (Array.isArray(value) && value.length === 0) return;
  out[key] = value;
}
