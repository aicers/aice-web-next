/**
 * Menu-neutral pivot-filter encoding for Detection URLs.
 *
 * The Investigation page's Overview and Related tabs build pivot
 * links into Detection (`/detection?source=...&window=1d`). This
 * module owns that URL shape so both sides — the link builders on
 * the Investigation page and the reader on the Detection page —
 * stay in sync without depending on each other.
 *
 * v1 is deliberately minimal: params round-trip into active-filter
 * chip descriptors rendered by the Detection shell's chip toolbar.
 * Future Detection phases will translate the same params into the
 * concrete `EventListFilterInput` that drives the list query; the
 * URL shape is stable across that transition.
 */
export type PivotWindow = "1d" | "7d";

export interface PivotFilterParams {
  source?: string;
  destination?: string;
  kind?: string;
  origPort?: number;
  respPort?: number;
  proto?: number;
  window?: PivotWindow;
}

export type PivotKey = keyof PivotFilterParams;

const WINDOW_VALUES: readonly PivotWindow[] = ["1d", "7d"];

function isPivotWindow(value: string): value is PivotWindow {
  return (WINDOW_VALUES as readonly string[]).includes(value);
}

function readString(
  source: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const raw = source[key];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readFiniteInt(
  source: Record<string, string | string[] | undefined>,
  key: string,
): number | undefined {
  const raw = readString(source, key);
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

/**
 * Decode Detection pivot search params. Unknown or malformed entries
 * are dropped silently — the Detection page treats the URL as a
 * best-effort handoff, not a form to validate.
 */
export function parsePivotSearchParams(
  source: Record<string, string | string[] | undefined>,
): PivotFilterParams {
  const window = readString(source, "window");
  return {
    source: readString(source, "source"),
    destination: readString(source, "destination"),
    kind: readString(source, "kind"),
    origPort: readFiniteInt(source, "origPort"),
    respPort: readFiniteInt(source, "respPort"),
    proto: readFiniteInt(source, "proto"),
    window: window && isPivotWindow(window) ? window : undefined,
  };
}

/**
 * Encode pivot params into a `/detection?…` URL. Undefined fields
 * are omitted so shared URLs stay tidy.
 */
export function buildDetectionPivotUrl(params: PivotFilterParams): string {
  const search = new URLSearchParams();
  if (params.source) search.set("source", params.source);
  if (params.destination) search.set("destination", params.destination);
  if (params.kind) search.set("kind", params.kind);
  if (params.origPort !== undefined) {
    search.set("origPort", String(params.origPort));
  }
  if (params.respPort !== undefined) {
    search.set("respPort", String(params.respPort));
  }
  if (params.proto !== undefined) search.set("proto", String(params.proto));
  if (params.window) search.set("window", params.window);
  const qs = search.toString();
  return qs ? `/detection?${qs}` : "/detection";
}

export interface PivotChipLabels {
  source: string;
  destination: string;
  kind: string;
  origPort: string;
  respPort: string;
  proto: string;
  window: string;
  windowLastDay: string;
  windowLastWeek: string;
}

export interface PivotChip {
  id: PivotKey;
  label: string;
  value: string;
}

/**
 * Build a display-ready chip descriptor list from pivot params.
 * Order is stable (same order as `PivotKey` declarations) so the
 * chip bar is deterministic across renders.
 */
export function buildPivotChips(
  params: PivotFilterParams,
  labels: PivotChipLabels,
): PivotChip[] {
  const chips: PivotChip[] = [];
  if (params.source) {
    chips.push({ id: "source", label: labels.source, value: params.source });
  }
  if (params.destination) {
    chips.push({
      id: "destination",
      label: labels.destination,
      value: params.destination,
    });
  }
  if (params.kind) {
    chips.push({ id: "kind", label: labels.kind, value: params.kind });
  }
  if (params.origPort !== undefined) {
    chips.push({
      id: "origPort",
      label: labels.origPort,
      value: String(params.origPort),
    });
  }
  if (params.respPort !== undefined) {
    chips.push({
      id: "respPort",
      label: labels.respPort,
      value: String(params.respPort),
    });
  }
  if (params.proto !== undefined) {
    chips.push({
      id: "proto",
      label: labels.proto,
      value: String(params.proto),
    });
  }
  if (params.window) {
    chips.push({
      id: "window",
      label: labels.window,
      value:
        params.window === "1d" ? labels.windowLastDay : labels.windowLastWeek,
    });
  }
  return chips;
}
