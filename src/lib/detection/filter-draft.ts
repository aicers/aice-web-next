import type { EndpointEntry } from "./endpoint-filter";
import type { PeriodKey } from "./period";
import type { FlowKind, LearningMethod } from "./types";

/**
 * De-dupe and trim-normalize a tag-input array. Mirrors the drawer's
 * TagInput input handling so submit-time normalization produces the
 * same canonical list the UI already renders.
 */
function normalizeTagList(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Editable snapshot of the Detection filter owned by the filter
 * drawer while the user is composing edits. Kept framework-agnostic
 * so shared filter-assembly code (e.g. `buildAppliedFilter`) does
 * not have to reach into the `"use client"` drawer component.
 */
export interface DetectionFilterDraft {
  period: PeriodKey | null;
  startLocal: string;
  endLocal: string;
  /**
   * ISO-8601 UTC strings used on Apply. Kept in sync with the
   * local-input fields: a chip selection writes the raw
   * `computePeriodRange()` instants here (seconds/ms intact). A
   * manual edit to either input normalizes BOTH sides from their
   * visible `datetime-local` values so the submitted range exactly
   * matches what the drawer shows — otherwise a one-sided edit
   * after a chip selection would leave the un-edited side at
   * full precision while the visible field shows minute precision.
   */
  startIso: string | null;
  endIso: string | null;
  directions: FlowKind[];
  endpoints: EndpointEntry[];
  /**
   * Confidence range in [0, 1] with two-decimal precision.
   * `[0, 1]` is the "no filter" default; the shell drops both
   * `confidenceMin`/`confidenceMax` from the submitted filter in
   * that case so REview returns the unrestricted result set.
   */
  confidenceMin: number;
  confidenceMax: number;
  /**
   * Selected sensor Node IDs. Submitted as `sensors: [<id>, ...]`
   * in the `EventListFilterInput`. Customer is intentionally absent
   * from the draft — it is a placeholder while the Customer
   * directory is unmodelled and must never reach the filter.
   */
  sensorIds: string[];
  levels: readonly number[];
  countries: readonly string[];
  learningMethods: readonly LearningMethod[];
  categories: readonly number[];
  kinds: readonly string[];
  /** Single-string free-form fields — source/destination IP or hostname text. */
  source: string;
  destination: string;
  /** Tag-input free-form fields. */
  keywords: string[];
  hostnames: string[];
  userIds: string[];
  userNames: string[];
  userDepartments: string[];
}

export const CONFIDENCE_DEFAULT_MIN = 0;
export const CONFIDENCE_DEFAULT_MAX = 1;
export const CONFIDENCE_STEP = 0.01;

/**
 * Convert an ISO-8601 UTC string to the `YYYY-MM-DDTHH:mm` format
 * `<input type="datetime-local">` expects, in the user's local
 * timezone. Returns `""` on an unparseable input so the input
 * renders empty rather than with `NaN`.
 */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/**
 * Convert a `<input type="datetime-local">` string (interpreted in
 * the browser's local timezone) back to an ISO-8601 UTC string
 * suitable for `EventListFilterInput.start`/`end`. Returns `null`
 * on an empty or unparseable input.
 */
export function localInputToIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Draft transition for a manual Start edit. Clears the selected
 * Period chip and normalizes BOTH ISO fields from the visible
 * `datetime-local` strings so a one-sided edit after a chip
 * selection cannot leave `endIso` at full precision while the End
 * input shows minute precision.
 */
export function applyManualStart(
  draft: DetectionFilterDraft,
  value: string,
): DetectionFilterDraft {
  return {
    ...draft,
    period: null,
    startLocal: value,
    startIso: localInputToIso(value),
    endIso: localInputToIso(draft.endLocal),
  };
}

/**
 * Canonicalize a draft for submit: trim the single-string fields and
 * de-dupe/trim each tag field so a blur-committed trailing draft plus
 * any whitespace padding reaches the parent in the same form the drawer
 * actually renders. The parent mirrors the result back into its cached
 * draft so reopening the drawer shows the value that was committed —
 * not the original padded input.
 */
export function normalizeDraftForSubmit(
  draft: DetectionFilterDraft,
): DetectionFilterDraft {
  return {
    ...draft,
    source: draft.source.trim(),
    destination: draft.destination.trim(),
    keywords: normalizeTagList(draft.keywords),
    hostnames: normalizeTagList(draft.hostnames),
    userIds: normalizeTagList(draft.userIds),
    userNames: normalizeTagList(draft.userNames),
    userDepartments: normalizeTagList(draft.userDepartments),
  };
}

/** Symmetric counterpart of `applyManualStart` for the End input. */
export function applyManualEnd(
  draft: DetectionFilterDraft,
  value: string,
): DetectionFilterDraft {
  return {
    ...draft,
    period: null,
    endLocal: value,
    startIso: localInputToIso(draft.startLocal),
    endIso: localInputToIso(value),
  };
}

/**
 * Whether the draft's time range is acceptable for submission.
 * Apply and Save share this gate so a draft that Apply would reject
 * (missing or reversed start/end) cannot be persisted as a saved
 * filter via the drawer's Save button.
 */
export function isDraftRangeValid(
  draft: Pick<DetectionFilterDraft, "startIso" | "endIso">,
): boolean {
  if (!draft.startIso || !draft.endIso) return false;
  return Date.parse(draft.startIso) < Date.parse(draft.endIso);
}

/**
 * Whether the draft's confidence range equals the `[0, 1]` default
 * (i.e. no confidence filter should be submitted). Shared between
 * the drawer and the filter-assembly helper so both agree on the
 * default check without duplicating the magic numbers.
 */
export function isConfidenceDefault(draft: {
  confidenceMin: number;
  confidenceMax: number;
}): boolean {
  return (
    draft.confidenceMin === CONFIDENCE_DEFAULT_MIN &&
    draft.confidenceMax === CONFIDENCE_DEFAULT_MAX
  );
}

/**
 * Clamp a raw numeric string entered in a confidence input into the
 * `[0, 1]` domain and round to two-decimal precision. An unparseable
 * input falls back to the supplied `fallback` so a momentarily empty
 * field can't yank the draft to `NaN`.
 */
export function parseConfidenceValue(raw: string, fallback: number): number {
  const trimmed = raw.trim();
  if (trimmed === "") return fallback;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.min(
    CONFIDENCE_DEFAULT_MAX,
    Math.max(CONFIDENCE_DEFAULT_MIN, n),
  );
  return Math.round(clamped * 100) / 100;
}

/**
 * Produce the string fed into a `<input type="number">` for a
 * confidence value. Two decimals matches the step, which keeps the
 * browser's native validation aligned with the draft value.
 */
export function formatConfidenceInput(value: number): string {
  return value.toFixed(2);
}

/**
 * Apply a new confidence min to the draft, enforcing the
 * `min ≤ max` invariant by snapping max upward when the new min
 * would overtake it. Acceptance: "Inputs cannot produce min > max."
 */
export function setConfidenceMin(
  draft: DetectionFilterDraft,
  next: number,
): DetectionFilterDraft {
  const min = clamp(next);
  return {
    ...draft,
    confidenceMin: min,
    confidenceMax: Math.max(min, draft.confidenceMax),
  };
}

/** Symmetric counterpart of `setConfidenceMin` for the max value. */
export function setConfidenceMax(
  draft: DetectionFilterDraft,
  next: number,
): DetectionFilterDraft {
  const max = clamp(next);
  return {
    ...draft,
    confidenceMax: max,
    confidenceMin: Math.min(draft.confidenceMin, max),
  };
}

/**
 * Draft transition for a confidence-min input event. Parses the
 * typed string, clamps into domain, and delegates to
 * `setConfidenceMin` so the min/max ordering invariant holds.
 */
export function applyConfidenceMin(
  draft: DetectionFilterDraft,
  raw: string,
): DetectionFilterDraft {
  const next = parseConfidenceValue(raw, draft.confidenceMin);
  return setConfidenceMin(draft, next);
}

/** Symmetric counterpart of `applyConfidenceMin` for the max input. */
export function applyConfidenceMax(
  draft: DetectionFilterDraft,
  raw: string,
): DetectionFilterDraft {
  const next = parseConfidenceValue(raw, draft.confidenceMax);
  return setConfidenceMax(draft, next);
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return CONFIDENCE_DEFAULT_MIN;
  const clamped = Math.min(
    CONFIDENCE_DEFAULT_MAX,
    Math.max(CONFIDENCE_DEFAULT_MIN, n),
  );
  return Math.round(clamped * 100) / 100;
}
