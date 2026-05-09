/**
 * Period selector for the Triage menu (Phase 1.A — discussion #447 §3.1).
 *
 * The selector accepts an arbitrary `[start, end]` pair within the
 * last 30 days and caps the duration at 30 days. Phase 1.A only
 * supports the last-30-days window because corpus retention isn't
 * yet available — when retention lands, the lower bound shifts and
 * this clamp expands accordingly.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Maximum duration the period selector accepts, in milliseconds. */
export const TRIAGE_MAX_DURATION_MS = 30 * DAY_MS;

/** Lower bound of the period selector relative to "now". */
export const TRIAGE_MAX_LOOKBACK_MS = 30 * DAY_MS;

/** Default window duration when the page first opens. */
export const TRIAGE_DEFAULT_DURATION_MS = 24 * HOUR_MS;

export interface TriagePeriod {
  /** ISO-8601 UTC start, inclusive. */
  startIso: string;
  /** ISO-8601 UTC end, exclusive. */
  endIso: string;
}

export interface ParsedPeriodResult {
  period: TriagePeriod;
  /**
   * `true` when the requested period was clamped to fit within the
   * 30-day lookback or the 30-day duration cap. The UI surfaces this
   * so an operator who pasted an out-of-range start understands why
   * the rendered window differs.
   */
  clamped: boolean;
}

/**
 * Build the default 24-hour window ending at `now`.
 */
export function defaultTriagePeriod(now: Date = new Date()): TriagePeriod {
  const end = new Date(now.getTime());
  const start = new Date(end.getTime() - TRIAGE_DEFAULT_DURATION_MS);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function isFiniteIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

/**
 * Parse a `start` / `end` pair from URL search-params and clamp it to
 * the Phase 1.A window. Invalid or missing inputs fall back to the
 * default 24-hour window.
 *
 * Clamping rules (in order):
 * 1. If `end` is in the future, bring it back to `now`.
 * 2. If `start` is older than `now - 30d`, bring it forward.
 * 3. If `end <= start`, fall back to the default window.
 * 4. If `end - start > 30d`, shrink `start` so the window is exactly
 *    30 days. Shrinking start (rather than end) preserves the
 *    operator's choice of "what timestamp am I asking about?".
 */
export function parseTriagePeriod(
  rawStart: unknown,
  rawEnd: unknown,
  now: Date = new Date(),
): ParsedPeriodResult {
  if (!isFiniteIso(rawStart) || !isFiniteIso(rawEnd)) {
    return { period: defaultTriagePeriod(now), clamped: false };
  }

  const nowMs = now.getTime();
  const lowerBoundMs = nowMs - TRIAGE_MAX_LOOKBACK_MS;
  let startMs = Date.parse(rawStart);
  let endMs = Date.parse(rawEnd);
  let clamped = false;

  if (endMs > nowMs) {
    endMs = nowMs;
    clamped = true;
  }
  if (startMs < lowerBoundMs) {
    startMs = lowerBoundMs;
    clamped = true;
  }
  if (endMs <= startMs) {
    return { period: defaultTriagePeriod(now), clamped: true };
  }
  if (endMs - startMs > TRIAGE_MAX_DURATION_MS) {
    startMs = endMs - TRIAGE_MAX_DURATION_MS;
    clamped = true;
  }

  return {
    period: {
      startIso: new Date(startMs).toISOString(),
      endIso: new Date(endMs).toISOString(),
    },
    clamped,
  };
}
