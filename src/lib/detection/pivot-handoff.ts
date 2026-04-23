/**
 * Translate Detection pivot URL params into the initial filter state
 * the page renders with, and serialize the committed filter back into
 * pivot URL params on every dispatch.
 *
 * A pivot link like `/detection?kind=HttpThreat&window=7d` has to
 * actually narrow the result set — the chip bar showing `Kind: HTTP
 * Threat` + `Period: Last 7 days` must match the query that ran.
 * Before #280 this helper existed only for the arrival direction; the
 * committed state never made it back to the URL, so reload / share /
 * Investigation `returnTo` dropped every filter edit the operator had
 * made in-session. Round 5 added round-trip for the pivot subset
 * (`kind`, `window`, source, destination, tag fields) and round 6
 * widened it to cover every filter dimension with a simple URL
 * representation — levels, countries, categories, learning methods,
 * directions, confidence, sensors, multi-kind, and explicit custom
 * time ranges — so `returnTo` now actually returns the operator to
 * the filtered tab they came from.
 *
 * The one filter dimension still absent from the round-trip is
 * Network/IP endpoints: their compound shape (direction × kind ×
 * host/network/range) plus the client-side stable-id requirement
 * needs more plumbing than the URL can cleanly carry, so they stay in
 * memory + chip bar until a future phase revisits them. A reload on
 * a URL that lacks `endpoint=` (which is every URL today) will drop
 * any custom Network/IP rules that were active at the time of the
 * jump-off.
 *
 * Round 8 added explicit "no time filter" round-trip: when the operator
 * clears the Period chip (or applies the drawer with both ISO inputs
 * blank), the URL carries `time=none` so reload, share, and the
 * Investigation `returnTo` decode back into the same no-time committed
 * state instead of silently re-introducing `Last 1 hour` via the
 * default-period fallback.
 */
import {
  computePeriodRange,
  DEFAULT_PERIOD_KEY,
  type PeriodKey,
} from "./period";
import type { EventListFilterInput, FlowKind, LearningMethod } from "./types";
import {
  mergePivotParams,
  type PivotFilterParams,
  type PivotWindow,
  pivotParamsFromFilterInput,
} from "./url-filters";

const WINDOW_TO_PERIOD: Record<PivotWindow, PeriodKey> = {
  "1d": "1d",
  "7d": "1w",
};

/**
 * Inverse mapping used when serializing the committed state back into
 * a pivot URL. Only the subset of periods that the pivot URL shape
 * can represent as a shorthand is emitted. `1h` / `12h` / `1m` / …
 * fall back to an explicit `start=` / `end=` pair so every period is
 * now URL-representable.
 */
const PERIOD_TO_WINDOW: Partial<Record<PeriodKey, PivotWindow>> = {
  "1d": "1d",
  "1w": "7d",
};

const CONFIDENCE_FULL_RANGE_MIN = 0;
const CONFIDENCE_FULL_RANGE_MAX = 1;

export interface PivotHandoff {
  initialFilter: EventListFilterInput;
  initialPeriod: PeriodKey | null;
  /**
   * Pivot params that have not been folded into the filter — ports
   * and proto are not yet modeled as first-class filter fields.
   * Every other dimension the URL carries is written directly into
   * `initialFilter`; leaving duplicates here would double-register
   * the corresponding chips on first paint.
   */
  residualPivotOnly: PivotFilterParams;
}

/**
 * Apply Detection pivot URL params on top of the default filter.
 * The returned shapes are ready to hand to the client shell: the
 * structured filter input, the matching period key (or `null` for a
 * custom range or no-time-filter state), and the pivot params left
 * over for pivot-only chip rendering.
 */
export function applyPivotHandoff(
  pivot: PivotFilterParams,
  now: Date = new Date(),
): PivotHandoff {
  // Explicit `start=` / `end=` in the URL outrank any `window=`
  // shorthand so a shared custom-range link restores the exact range
  // it was captured with. `period` is `null` for that path because
  // the shell's period control has no concept of "custom" once the
  // range is decoupled from a named window.
  //
  // `time=none` outranks both: it's the explicit "no time filter"
  // marker that round-trips a cleared Period chip through reload /
  // share / `returnTo`. Without it, the absence of every other time
  // param falls into the default-1h branch below and silently
  // re-introduces `Last 1 hour` on the next page load.
  const explicitStart = pivot.start;
  const explicitEnd = pivot.end;
  let period: PeriodKey | null;
  let start: string | undefined;
  let end: string | undefined;
  if (pivot.noTime) {
    period = null;
    start = undefined;
    end = undefined;
  } else if (explicitStart && explicitEnd) {
    period = null;
    start = explicitStart;
    end = explicitEnd;
  } else if (pivot.window && pivot.window in WINDOW_TO_PERIOD) {
    period = WINDOW_TO_PERIOD[pivot.window];
    const range = computePeriodRange(period, now);
    start = range.start;
    end = range.end;
  } else {
    period = DEFAULT_PERIOD_KEY;
    const range = computePeriodRange(period, now);
    start = range.start;
    end = range.end;
  }

  const input: EventListFilterInput = {};
  if (start) input.start = start;
  if (end) input.end = end;
  if (pivot.source) input.source = pivot.source;
  if (pivot.destination) input.destination = pivot.destination;
  // `kinds=` wins over a legacy `kind=` when both appear; otherwise
  // a single `kind=` lands in `input.kinds` as a one-element array so
  // the filter and the chip bar agree on the narrowing.
  const mergedKinds = mergeKinds(pivot.kind, pivot.kinds);
  if (mergedKinds.length > 0) input.kinds = mergedKinds;
  if (pivot.keywords?.length) input.keywords = pivot.keywords;
  if (pivot.hostnames?.length) input.hostnames = pivot.hostnames;
  if (pivot.userIds?.length) input.userIds = pivot.userIds;
  if (pivot.userNames?.length) input.userNames = pivot.userNames;
  if (pivot.userDepartments?.length) {
    input.userDepartments = pivot.userDepartments;
  }
  if (pivot.levels?.length) input.levels = [...pivot.levels];
  if (pivot.countries?.length) input.countries = [...pivot.countries];
  if (pivot.categories?.length) input.categories = [...pivot.categories];
  if (pivot.learningMethods?.length) {
    input.learningMethods = [...pivot.learningMethods];
  }
  if (pivot.directions?.length) input.directions = [...pivot.directions];
  if (pivot.confMin !== undefined) input.confidenceMin = pivot.confMin;
  if (pivot.confMax !== undefined) input.confidenceMax = pivot.confMax;
  if (pivot.sensors?.length) input.sensors = [...pivot.sensors];

  const residualPivotOnly: PivotFilterParams = {
    origPort: pivot.origPort,
    respPort: pivot.respPort,
    proto: pivot.proto,
  };

  return { initialFilter: input, initialPeriod: period, residualPivotOnly };
}

function mergeKinds(
  kind: string | undefined,
  kinds: readonly string[] | undefined,
): string[] {
  if (kinds && kinds.length > 0) return [...kinds];
  if (kind) return [kind];
  return [];
}

/**
 * Build the pivot URL params that represent the current committed
 * filter + period. Used by the Detection shell to rewrite the
 * browser URL after every query dispatch so reload, share, and
 * Investigation `returnTo` carry the same filter context the
 * operator is currently looking at.
 *
 * This is the serialization counterpart to {@link applyPivotHandoff}.
 * The two must agree: what `applyPivotHandoff` folds into
 * `initialFilter` + `initialPeriod`, `urlParamsForCommitted` must be
 * able to round-trip back out. Without that, a chip removal in the
 * Level or Confidence dimension would silently rewrite the URL to
 * one that decodes into a looser filter on reload — reviewer round 6
 * flagged that every dimension beyond the pivot subset was dropping
 * off the URL.
 *
 * `residualPivotOnly` carries the URL-only chips that have no
 * first-class filter field yet (ports, proto). They survive every
 * dispatch until the operator explicitly removes them.
 *
 * Dimensions serialized:
 *   - `source`, `destination`, tag fields (keywords, hostnames, user*)
 *   - `kind=` for single-value selections, `kinds=` for multi-select
 *   - `window=1d|7d` when the period matches, else `start=` / `end=`
 *     so `1h` / `12h` / `1m` / custom ranges still round-trip
 *   - `time=none` when the committed filter has no time constraint
 *     (Period chip cleared / drawer applied with both ISO inputs blank)
 *   - `level=`, `country=`, `category=`, `learningMethod=`,
 *     `direction=`, `sensor=` for the multi-select / enum dimensions
 *   - `confMin=` / `confMax=` when the committed range is not the
 *     `[0, 1]` default
 *
 * Not yet serialized: Network/IP endpoints — see module header.
 */
export function urlParamsForCommitted(
  input: EventListFilterInput,
  period: PeriodKey | null,
  residualPivotOnly: PivotFilterParams,
): PivotFilterParams {
  const base = pivotParamsFromFilterInput(input);
  const kinds = input.kinds ?? [];
  const kind = kinds.length === 1 ? kinds[0] : undefined;
  const kindsMulti = kinds.length > 1 ? [...kinds] : undefined;
  const window = period ? PERIOD_TO_WINDOW[period] : undefined;
  // No-time committed state — the operator cleared the Period chip or
  // applied the drawer with both datetime inputs blank. Emit the
  // explicit `time=none` marker so the next reload / share /
  // `returnTo` decode round-trips back into the same no-time state
  // instead of falling into the parser's default-1h branch.
  const noTime =
    period === null && !input.start && !input.end ? true : undefined;
  // Emit `start=` / `end=` only when `window=` can't represent the
  // active period (e.g. `1h`, `1m`, or a `null` period from a custom
  // range). When a window shorthand applies we skip the explicit
  // range so the URL stays tidy and the re-parse doesn't see both.
  const start = !window && !noTime && input.start ? input.start : undefined;
  const end = !window && !noTime && input.end ? input.end : undefined;
  const levels = arrayOrUndefined(input.levels?.filter(isNumber));
  const countries = arrayOrUndefined(input.countries);
  const categories = arrayOrUndefined(input.categories?.filter(isNumber));
  const learningMethods = arrayOrUndefined(
    input.learningMethods as readonly LearningMethod[] | null | undefined,
  );
  const directions = arrayOrUndefined(
    input.directions as readonly FlowKind[] | null | undefined,
  );
  const sensors = arrayOrUndefined(input.sensors);
  const confidence = pickConfidence(input.confidenceMin, input.confidenceMax);
  return mergePivotParams(residualPivotOnly, {
    ...base,
    kind,
    kinds: kindsMulti,
    window,
    start,
    end,
    noTime,
    levels,
    countries,
    categories,
    learningMethods,
    directions,
    sensors,
    confMin: confidence?.min,
    confMax: confidence?.max,
  });
}

function arrayOrUndefined<T>(
  values: readonly T[] | null | undefined,
): T[] | undefined {
  if (!values || values.length === 0) return undefined;
  return [...values];
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function pickConfidence(
  min: number | null | undefined,
  max: number | null | undefined,
): { min: number | undefined; max: number | undefined } | null {
  const hasMin = typeof min === "number" && Number.isFinite(min);
  const hasMax = typeof max === "number" && Number.isFinite(max);
  if (!hasMin && !hasMax) return null;
  // Treat a `[0, 1]` range as "unfiltered" and drop it from the URL
  // so share/reload doesn't carry a noop constraint.
  const effectiveMin = hasMin ? min : CONFIDENCE_FULL_RANGE_MIN;
  const effectiveMax = hasMax ? max : CONFIDENCE_FULL_RANGE_MAX;
  if (
    effectiveMin === CONFIDENCE_FULL_RANGE_MIN &&
    effectiveMax === CONFIDENCE_FULL_RANGE_MAX
  ) {
    return null;
  }
  return {
    min: hasMin ? min : undefined,
    max: hasMax ? max : undefined,
  };
}
