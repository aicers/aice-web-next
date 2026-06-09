/**
 * The Event page view-mode toggle.
 *
 * Mirrors aice-web's `ViewTypes`: the Event page can be browsed as a
 * record **table** (`events`) or as an aggregation **chart**
 * (`statistics`). The active mode rides in the URL (`?view=`) so a view
 * is shareable and survives a reload, exactly like the filter.
 *
 * aice-web's modes were `Events | Time Series`; `statistics` is a new
 * view introduced in E5 Part 1. E5 Part 2 adds `timeseries` — the
 * Periodic Time Series chart of a sampling policy's numeric series — so
 * the toggle now surfaces a flat `Events | Statistics | Time Series`.
 */

export const VIEW_MODES = ["events", "statistics", "timeseries"] as const;

export type ViewMode = (typeof VIEW_MODES)[number];

export const DEFAULT_VIEW_MODE: ViewMode = "events";

/** URL query-string name that persists the active view mode. */
export const VIEW_MODE_PARAM = "view";

export function isViewMode(value: string): value is ViewMode {
  return (VIEW_MODES as readonly string[]).includes(value);
}

/**
 * Coerce an arbitrary string (e.g. a stale URL param) into a supported
 * view mode, falling back to {@link DEFAULT_VIEW_MODE}.
 */
export function coerceViewMode(value: string | undefined): ViewMode {
  return value !== undefined && isViewMode(value) ? value : DEFAULT_VIEW_MODE;
}

/**
 * Decode the active view mode from URL search params. Reads the same
 * `Record<string, string | string[]>` shape the Next.js server
 * component receives, so a repeated param (`?view=a&view=b`) is ignored
 * rather than mis-parsed.
 */
export function parseViewModeFromSearchParams(
  source: Record<string, string | string[] | undefined>,
): ViewMode {
  const raw = source[VIEW_MODE_PARAM];
  return coerceViewMode(typeof raw === "string" ? raw : undefined);
}
