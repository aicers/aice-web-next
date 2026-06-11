/**
 * Drill-down (pivot) helpers for the Detection result list
 * (Phase Detection-12).
 *
 * The result-list cells call into {@link buildPivotPatch} to turn a
 * (column, value) pair into a {@link PivotPatch} the multi-tab
 * wrapper can apply to a cloned filter. Routing the activation —
 * "open / focus a tab and run the pivoted filter" — happens in the
 * wrapper; this module is pure data-shape work so the pivot
 * vocabulary stays import-cheap and unit-testable.
 *
 * Column → filter-field mapping for v1 (issue #283):
 *
 *   origAddr / origAddrs     → endpoints[FROM].custom.hosts (add)
 *   respAddr / respAddrs     → endpoints[TO].custom.hosts (add)
 *   origCountry / origCountries / respCountry / respCountries
 *                            → countries (array — add unique)
 *   hostname / hostnames     → hostnames (array — add unique)
 *   userId                   → userIds (array — add unique)
 *   userName                 → userNames (array — add unique)
 *   userDepartment           → userDepartments (array — add unique)
 *   kind                     → kinds (array — add unique)
 *   category                 → categories (array — add unique)
 *   level                    → levels (array — add unique)
 *   direction                → directions (array — add unique)
 *
 * Sensor / customer columns map to deferred placeholder filter
 * fields and are intentionally not pivotable in v1.
 *
 * Exclusion (NOT) pivots are an explicit non-goal — the structured
 * filter schema cannot express them in v1.
 */

import {
  createEndpointEntryId,
  type EndpointEntry,
  preservePredefinedEndpointInputs,
} from "./endpoint-filter";
import type { Filter } from "./filter";
import {
  type FilterIdentityInput,
  normalizeFilterIdentity,
} from "./filter-identity";
import type { PeriodKey } from "./period";
import type {
  EventListFilterInput,
  FlowKind,
  LearningMethod,
  ThreatLevel,
} from "./types";

const THREAT_LEVEL_VALUE_SET: ReadonlySet<ThreatLevel> = new Set([
  "VERY_LOW",
  "LOW",
  "MEDIUM",
  "HIGH",
  "VERY_HIGH",
]);

/**
 * Column key the result-list cell hands to {@link buildPivotPatch}.
 * Keep the vocabulary identical to the field names in the curated
 * `Event` subtypes so the table stays self-explanatory at the call
 * site.
 */
export type PivotColumnKey =
  | "origAddr"
  | "respAddr"
  | "origCountry"
  | "respCountry"
  | "hostname"
  | "userId"
  | "userName"
  | "userDepartment"
  | "kind"
  | "category"
  | "level"
  | "direction";

/**
 * Patch the multi-tab wrapper applies to a cloned active-tab filter.
 * Each variant carries the minimum data needed to merge the click
 * into `EventListFilterInput`; {@link applyPivotPatch} owns the
 * merge semantics so the table stays declarative.
 */
export type PivotPatch =
  | {
      kind: "endpointHost";
      direction: "FROM" | "TO";
      host: string;
      /** Display label used in toasts / aria text. */
      displayValue: string;
    }
  | {
      kind: "stringArray";
      field:
        | "hostnames"
        | "userIds"
        | "userNames"
        | "userDepartments"
        | "countries"
        | "kinds";
      value: string;
      displayValue: string;
    }
  | {
      kind: "numberArray";
      field: "categories";
      value: number;
      displayValue: string;
    }
  | {
      kind: "levelArray";
      value: ThreatLevel;
      displayValue: string;
    }
  | {
      kind: "directionArray";
      value: FlowKind;
      displayValue: string;
    }
  | {
      kind: "learningMethodArray";
      value: LearningMethod;
      displayValue: string;
    };

export interface PivotCellValue {
  /** Raw value from the event row — IP, country code, kind, etc. */
  raw: string | number | FlowKind | LearningMethod | ThreatLevel;
  /**
   * Optional friendly label for toast / aria text. Falls back to the
   * raw value coerced to string when omitted.
   */
  display?: string;
}

/**
 * Translate a `(column, value)` pair into a {@link PivotPatch}.
 * Returns `null` when the column is not pivotable in v1 or when the
 * value fails the column's value-shape check (e.g. a non-numeric
 * `level`). Callers hide the affordance for `null` results so the
 * UI never offers a click that would no-op.
 */
export function buildPivotPatch(
  column: PivotColumnKey,
  value: PivotCellValue,
): PivotPatch | null {
  const display =
    value.display ??
    (typeof value.raw === "string" ? value.raw : String(value.raw));
  switch (column) {
    case "origAddr": {
      const host = stringValue(value.raw);
      if (!host) return null;
      return {
        kind: "endpointHost",
        direction: "FROM",
        host,
        displayValue: display,
      };
    }
    case "respAddr": {
      const host = stringValue(value.raw);
      if (!host) return null;
      return {
        kind: "endpointHost",
        direction: "TO",
        host,
        displayValue: display,
      };
    }
    case "origCountry":
    case "respCountry": {
      const v = stringValue(value.raw);
      if (!v) return null;
      return {
        kind: "stringArray",
        field: "countries",
        value: v,
        displayValue: display,
      };
    }
    case "hostname": {
      const v = stringValue(value.raw);
      if (!v) return null;
      return {
        kind: "stringArray",
        field: "hostnames",
        value: v,
        displayValue: display,
      };
    }
    case "userId": {
      const v = stringValue(value.raw);
      if (!v) return null;
      return {
        kind: "stringArray",
        field: "userIds",
        value: v,
        displayValue: display,
      };
    }
    case "userName": {
      const v = stringValue(value.raw);
      if (!v) return null;
      return {
        kind: "stringArray",
        field: "userNames",
        value: v,
        displayValue: display,
      };
    }
    case "userDepartment": {
      const v = stringValue(value.raw);
      if (!v) return null;
      return {
        kind: "stringArray",
        field: "userDepartments",
        value: v,
        displayValue: display,
      };
    }
    case "kind": {
      const v = stringValue(value.raw);
      if (!v) return null;
      return {
        kind: "stringArray",
        field: "kinds",
        value: v,
        displayValue: display,
      };
    }
    case "category": {
      const n = numberValue(value.raw);
      if (n === null) return null;
      return {
        kind: "numberArray",
        field: "categories",
        value: n,
        displayValue: display,
      };
    }
    case "level": {
      const v = stringValue(value.raw);
      if (!v || !THREAT_LEVEL_VALUE_SET.has(v as ThreatLevel)) return null;
      return {
        kind: "levelArray",
        value: v as ThreatLevel,
        displayValue: display,
      };
    }
    case "direction": {
      const v = stringValue(value.raw);
      if (!v) return null;
      if (v !== "INBOUND" && v !== "OUTBOUND" && v !== "INTERNAL") return null;
      return {
        kind: "directionArray",
        value: v,
        displayValue: display,
      };
    }
    default: {
      // Exhaustiveness gate — the switch covers every PivotColumnKey
      // arm so adding a new column without updating this file fails
      // type-check at the call site of `assertNever`.
      const _exhaustive: never = column;
      return _exhaustive;
    }
  }
}

function stringValue(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function numberValue(raw: unknown): number | null {
  if (typeof raw !== "number") return null;
  if (!Number.isFinite(raw)) return null;
  return raw;
}

export interface PivotApplyResult {
  /** New filter with the patch merged in. */
  filter: Filter;
  /** Updated `EndpointEntry[]` mirror — needed for endpointHost patches. */
  endpoints: EndpointEntry[];
}

/**
 * Merge a pivot patch into an active tab's `(filter, endpoints)`
 * pair. Pure / deterministic: same inputs always yield the same
 * output, which lets the wrapper's identity comparison see "this
 * patch is already applied" without rerunning the merge against
 * stale state.
 *
 * `mode: "query"` filters are returned unchanged — pivot is a
 * structured-mode operation in v1, and the query-language editor
 * lands later.
 */
export function applyPivotPatch(
  filter: Filter,
  endpoints: readonly EndpointEntry[],
  patch: PivotPatch,
): PivotApplyResult {
  if (filter.mode !== "structured") {
    return { filter, endpoints: [...endpoints] };
  }
  const input: EventListFilterInput = { ...filter.input };
  const nextEndpoints: EndpointEntry[] = [...endpoints];

  switch (patch.kind) {
    case "endpointHost": {
      // Issue #283: "Add as new Endpoint". Pivoted hosts are
      // appended as fresh `EndpointEntry` rows so each click
      // produces a single visible custom-network rule the operator
      // can later remove via the chip × — collapsing into an
      // existing entry would lose that affordance. Skip when the
      // host is already covered by a same-direction entry of the
      // same shape, so a double-click does not silently double the
      // chip count.
      const direction = patch.direction === "FROM" ? "SOURCE" : "DESTINATION";
      const alreadyPresent = nextEndpoints.some(
        (e) =>
          e.selected &&
          e.kind === "host" &&
          e.host === patch.host &&
          e.direction === direction,
      );
      if (!alreadyPresent) {
        nextEndpoints.push({
          id: createEndpointEntryId(),
          raw: patch.host,
          kind: "host",
          host: patch.host,
          direction,
          selected: true,
        });
      }
      // Re-derive the submitted endpoints array from the merged
      // entries so the wire payload stays in sync with the chip bar.
      // Reviewer Round 2: the original schema payload may carry
      // entries the `EndpointEntry` UI mirror cannot represent
      // (today: `predefined` references to server-defined networks).
      // Walking only the mirror would silently drop those entries
      // and broaden the pivoted filter. Preserve them as
      // predefined-only references — any `custom` payload they also
      // carried is already in the mirror.
      const customSide = endpointsToEndpointInputsLite(nextEndpoints) ?? [];
      const preserved = preservePredefinedEndpointInputs(
        filter.input.endpoints,
      );
      const merged = [...preserved, ...customSide];
      if (merged.length === 0) {
        delete input.endpoints;
      } else {
        input.endpoints = merged;
      }
      break;
    }
    case "stringArray": {
      const current = input[patch.field] ?? [];
      if (current.includes(patch.value)) {
        // Already present — return the same input untouched so the
        // identity check downstream sees "no-op" without doing array
        // work. (We still return a new object so callers do not
        // mutate the caller's reference accidentally.)
        break;
      }
      input[patch.field] = [...current, patch.value];
      break;
    }
    case "numberArray": {
      const current = (input.categories ?? []).filter(
        (v): v is number => typeof v === "number",
      );
      if (current.includes(patch.value)) break;
      input.categories = [...current, patch.value];
      break;
    }
    case "levelArray": {
      const current = input.levels ?? [];
      if (current.includes(patch.value)) break;
      input.levels = [...current, patch.value];
      break;
    }
    case "directionArray": {
      const current = input.directions ?? [];
      // The active filter encodes "no filter" as either an absent
      // `directions` or all three values present. Pivoting from
      // "no filter" should narrow down to just the clicked value
      // rather than become "no filter" again because the click
      // happens to be one of the three.
      const noFilter =
        current.length === 0 ||
        (current.includes("INBOUND") &&
          current.includes("OUTBOUND") &&
          current.includes("INTERNAL"));
      if (noFilter) {
        input.directions = [patch.value];
      } else if (!current.includes(patch.value)) {
        input.directions = [...current, patch.value];
      }
      break;
    }
    case "learningMethodArray": {
      const current = input.learningMethods ?? [];
      if (!current.includes(patch.value)) {
        input.learningMethods = [...current, patch.value];
      }
      break;
    }
  }

  return {
    filter: { mode: "structured", input },
    endpoints: nextEndpoints,
  };
}

/**
 * Result of {@link openPivotTab}: the wrapper inspects `kind` to
 * decide whether to toast / focus / create, and reads `target` for
 * the latter two paths. Pure / serializable so the decision can be
 * unit-tested without standing up React state.
 */
export type PivotAction =
  | {
      kind: "toastDuplicate";
      /** Display value for the "Already filtered by X" toast. */
      displayValue: string;
    }
  | {
      kind: "focusTab";
      tabId: string;
      displayValue: string;
    }
  | {
      kind: "createTab";
      filter: Filter;
      endpoints: EndpointEntry[];
      /**
       * Period to seed the new tab with. Pivot inherits the active
       * tab's period so a relative "Last 1 hour" tab pivots into a
       * "Last 1 hour" tab instead of being snapped to a literal ISO
       * range that drifts as the operator works.
       */
      period: PeriodKey | null;
      displayValue: string;
    }
  | {
      kind: "toastCapReached";
      displayValue: string;
    };

export interface PivotTabSummary {
  id: string;
  identity: FilterIdentityInput;
}

export interface OpenPivotTabArgs {
  /** Patch derived from the click. Must already be non-null. */
  patch: PivotPatch;
  /** Active tab's `(filter, endpoints, period)` triple. */
  active: {
    id: string;
    filter: Filter;
    endpoints: readonly EndpointEntry[];
    period: PeriodKey | null;
  };
  /**
   * Identity inputs for every other tab (the active tab is included
   * for convenience — the helper filters it out itself, so callers
   * can pass the full list).
   */
  tabs: readonly PivotTabSummary[];
  /**
   * Maximum tab count enforced by the multi-tab wrapper. Passed in so
   * the helper does not couple to the constant module — tests can pin
   * a low cap to exercise the toast branch.
   */
  maxTabs: number;
  /**
   * Explicit period for the created tab, overriding the active tab's
   * period. Quick peek pivots advertise a fixed window (source /
   * destination → last 24h, kind → last 7d) rather than inheriting
   * the active tab's period like the result-list / analytics pivots
   * do. The override participates in the duplicate / focus identity
   * checks too, so a pivot that differs from the active tab only by
   * window opens its own tab instead of being treated as a no-op.
   * Omitted (`undefined`) → inherit `active.period`; an explicit
   * `null` forces the page-default (no period) tab.
   */
  periodOverride?: PeriodKey | null;
}

/**
 * Decide what should happen when the operator activates a pivot
 * affordance.
 *
 * Decision order (matches the issue's behaviour spec):
 *   1. Compute the target filter by applying `patch` to the active
 *      tab's filter / endpoints.
 *   2. If the target identity equals the active tab's identity →
 *      `toastDuplicate`.
 *   3. If any other tab's identity matches → `focusTab` with that
 *      tab's id.
 *   4. Else if the wrapper is at `maxTabs` → `toastCapReached`.
 *   5. Else `createTab` with the merged filter / endpoints / period.
 */
export function openPivotTab(args: OpenPivotTabArgs): PivotAction {
  const { patch, active, tabs, maxTabs } = args;
  // `undefined` → inherit the active tab's period; an explicit period
  // (including `null`) overrides it. The target period feeds both the
  // identity checks below and the created tab, so a pivot that differs
  // only by window is a distinct tab rather than a duplicate.
  const targetPeriod =
    args.periodOverride !== undefined ? args.periodOverride : active.period;
  const merged = applyPivotPatch(active.filter, active.endpoints, patch);
  const targetIdentity = normalizeFilterIdentity({
    filter: merged.filter,
    period: targetPeriod,
  });
  const activeIdentity = normalizeFilterIdentity({
    filter: active.filter,
    period: active.period,
  });
  if (targetIdentity === activeIdentity) {
    return { kind: "toastDuplicate", displayValue: patch.displayValue };
  }
  for (const tab of tabs) {
    if (tab.id === active.id) continue;
    if (normalizeFilterIdentity(tab.identity) === targetIdentity) {
      return {
        kind: "focusTab",
        tabId: tab.id,
        displayValue: patch.displayValue,
      };
    }
  }
  if (tabs.length >= maxTabs) {
    return { kind: "toastCapReached", displayValue: patch.displayValue };
  }
  return {
    kind: "createTab",
    filter: merged.filter,
    endpoints: merged.endpoints,
    period: targetPeriod,
    displayValue: patch.displayValue,
  };
}

/**
 * Local copy of the "entries → submitted endpoints" reducer to keep
 * this module side-effect-free. The drawer's `endpointsToEndpointInputs`
 * does the same thing but lives next to the chip-builder helpers; we
 * inline it here so a pivot can run from a server-rendered or test
 * context that does not import the larger UI module surface.
 */
function endpointsToEndpointInputsLite(
  entries: EndpointEntry[],
): EventListFilterInput["endpoints"] {
  type Bucket = {
    direction: EndpointEntry["direction"];
    hosts: string[];
    networks: string[];
    ranges: { start: string; end: string }[];
  };
  const buckets = new Map<EndpointEntry["direction"], Bucket>();
  for (const entry of entries) {
    if (!entry.selected) continue;
    let bucket = buckets.get(entry.direction);
    if (!bucket) {
      bucket = {
        direction: entry.direction,
        hosts: [],
        networks: [],
        ranges: [],
      };
      buckets.set(entry.direction, bucket);
    }
    if (entry.kind === "host" && entry.host) bucket.hosts.push(entry.host);
    else if (entry.kind === "network" && entry.network)
      bucket.networks.push(entry.network);
    else if (entry.kind === "range" && entry.range)
      bucket.ranges.push(entry.range);
  }
  const order: EndpointEntry["direction"][] = ["BOTH", "SOURCE", "DESTINATION"];
  const out: NonNullable<EventListFilterInput["endpoints"]> = [];
  for (const dir of order) {
    const b = buckets.get(dir);
    if (!b) continue;
    if (
      b.hosts.length === 0 &&
      b.networks.length === 0 &&
      b.ranges.length === 0
    ) {
      continue;
    }
    out.push({
      direction:
        dir === "SOURCE" ? "FROM" : dir === "DESTINATION" ? "TO" : null,
      custom: { hosts: b.hosts, networks: b.networks, ranges: b.ranges },
    });
  }
  return out;
}
