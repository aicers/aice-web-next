/**
 * Multi-tab result persistence for the Detection page (Phase
 * Detection-10).
 *
 * ## What a "tab's filter" is
 *
 * A tab stores the abstract {@link Filter} type defined in Phase
 * Detection-2 — `{ mode: "structured"; input: EventListFilterInput }`
 * or (forward-compat) `{ mode: "query"; text: string }`. It is **not**
 * a raw `EventListFilterInput`. URL serialization, sessionStorage
 * rehydration, saved-filter loads, and pivot activations all
 * round-trip through this `Filter` shape so the persistence layer
 * does not have to be rewritten when the search-language mode is
 * introduced later.
 *
 * ## URL vs. sessionStorage split
 *
 * **URL search params** carry *shareable* state: anything a link
 * recipient (Slack / bookmark / reload in another browser) is
 * expected to reproduce. At minimum that is the active tab's
 * `Filter` (serialized as flat `?source=…&period=…&…` params by
 * {@link ./filter-url.ts}) plus the active-tab index (`?tab=N`).
 * When the full working set fits inside a pragmatic URL-length
 * budget, every tab's filter rides along in a compact `?tabs=<json>`
 * param so a shared link reproduces the recipient's whole tab
 * strip — not just the one the author happened to be looking at.
 *
 * **`sessionStorage`** carries *private, non-shareable* state: every
 * tab's filter snapshot (including any extras that exceeded the URL
 * budget), the per-tab manual rename, and per-tab UI state that is
 * genuinely persisted — currently the analytics-strip expansion
 * flag. Other per-tab UI surfaces (scroll position, row popovers,
 * the quick-peek aside) are deliberately runtime-only; they belong
 * to the live page and are not written to storage. The snapshot is
 * scoped to the originating browser tab / context, so sharing a URL
 * never leaks another operator's working set.
 *
 * On load the URL state is the source of truth. When the URL
 * describes the full tab set (via `tabs=<json>`), it wins outright
 * and sessionStorage is only consulted for UI state like
 * `analyticsOpen` that was never URL-encoded. When the URL only
 * describes the active tab (budget exceeded at serialize time), the
 * sessionStorage snapshot is merged on top so the working set still
 * restores, and the active tab's filter is rebased around the URL.
 */

import {
  type EndpointEntry,
  endpointsToEndpointInputs,
} from "./endpoint-filter";
import type { Filter } from "./filter";
import { normalizeStructuredInput } from "./filter-input-normalize";
import type { PeriodKey } from "./period";
import { computePeriodRange, PERIOD_KEYS } from "./period";
import type { EventListFilterInput } from "./types";
import type { PivotFilterParams } from "./url-filters";

const PERIOD_KEY_SET: ReadonlySet<PeriodKey> = new Set(PERIOD_KEYS);

/**
 * A single tab's persisted state. The `filter` lives as the abstract
 * discriminated union from Phase Detection-2 so a future query-mode
 * tab can round-trip through the same storage without reshaping this
 * interface.
 */
export interface TabSnapshot {
  /** Stable id used as React key and sessionStorage anchor. */
  id: string;
  /**
   * Abstract {@link Filter}. Never a raw `EventListFilterInput` —
   * see module docstring.
   */
  filter: Filter;
  /** Committed period key, or `null` for an explicit time range. */
  period: PeriodKey | null;
  /** Endpoint entries that live parallel to the committed filter. */
  endpoints: EndpointEntry[];
  /**
   * URL-only pivot params (kind / ports / proto / window) carried
   * through for pivot round-trips. Not rendered as chips yet.
   */
  pivotOnly: PivotFilterParams;
  /**
   * Operator-supplied name. `null` means "auto-generate from the
   * filter summary"; a non-null string survives filter edits so the
   * operator's rename is preserved.
   */
  name: string | null;
  /**
   * When `true`, the shell auto-runs the tab's query the next time
   * the tab becomes active and has no cached result yet (set by the
   * initial SSR tab and by Apply). When `false`, the tab's result
   * pane renders the pre-query empty panel until the operator hits
   * Apply — this is how a fresh `+` tab behaves.
   */
  autoRun: boolean;
  /**
   * Per-tab UI state: whether the bottom analytics strip is
   * expanded. Session-only — never URL-encoded — so a shared link
   * never leaks another operator's preferred panel layout.
   */
  analyticsOpen: boolean;
}

export interface TabsSnapshot {
  tabs: TabSnapshot[];
  activeIndex: number;
}

/** Maximum number of tabs allowed simultaneously. */
export const TAB_CAP = 8;

/** Session storage key used to persist the non-shareable tab set. */
export const TABS_SESSION_KEY = "detection.tabs.v1";

/** URL search param for the active tab index. */
export const ACTIVE_TAB_PARAM = "tab";

/** Generate a random tab id. Uses `crypto.randomUUID` when available, a Math.random fallback otherwise so the module can be called from server code without tripping a ReferenceError. */
export function createTabId(): string {
  const cryptoRef =
    typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (cryptoRef && typeof cryptoRef.randomUUID === "function") {
    return cryptoRef.randomUUID();
  }
  // Fallback: 12 base36 chars of Math.random. Collision risk is fine
  // for an ≤8-item array that never leaves one browser tab.
  return `tab-${Math.random().toString(36).slice(2, 14)}`;
}

/** Shape of a single snapshot as it lands in sessionStorage. */
interface SerializedTab {
  id: string;
  filter: Filter;
  period: PeriodKey | null;
  endpoints: EndpointEntry[];
  pivotOnly: PivotFilterParams;
  name: string | null;
  autoRun: boolean;
  analyticsOpen: boolean;
}

interface SerializedTabs {
  v: 1;
  tabs: SerializedTab[];
  activeIndex: number;
}

/**
 * Encode the tabs array for sessionStorage. Exported separately from
 * the storage side-effect so callers can unit-test the serialization
 * without a JSDOM environment.
 */
export function serializeTabsForSession(state: TabsSnapshot): string {
  const payload: SerializedTabs = {
    v: 1,
    tabs: state.tabs.map((t) => ({
      id: t.id,
      filter: t.filter,
      period: t.period,
      endpoints: t.endpoints,
      pivotOnly: t.pivotOnly,
      name: t.name,
      autoRun: t.autoRun,
      analyticsOpen: t.analyticsOpen,
    })),
    activeIndex: state.activeIndex,
  };
  return JSON.stringify(payload);
}

/**
 * Decode a sessionStorage payload. Returns `null` for anything
 * malformed so the caller can fall back to a single-tab default
 * rather than throwing during hydration.
 */
export function parseTabsFromSession(raw: string | null): TabsSnapshot | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as Partial<SerializedTabs>;
  if (candidate.v !== 1) return null;
  if (
    !Array.isArray(candidate.tabs) ||
    candidate.tabs.length === 0 ||
    // Decode-time enforcement of the issue's hard 8-tab cap. A
    // tampered / stale sessionStorage payload is rejected outright
    // rather than rehydrated into an over-cap state the interactive
    // shell would otherwise accept as-is.
    candidate.tabs.length > TAB_CAP
  ) {
    return null;
  }
  const tabs: TabSnapshot[] = [];
  for (const t of candidate.tabs) {
    if (!t || typeof t !== "object") return null;
    const tab = t as Partial<SerializedTab>;
    if (typeof tab.id !== "string" || tab.id.length === 0) return null;
    const normalizedFilter = normalizeSessionFilter(tab.filter);
    if (!normalizedFilter) return null;
    // Unknown period keys are rejected rather than cast through —
    // letting a bogus `period` flow into `resolveTabPeriod` /
    // `computePeriodRange` would fabricate `NaN` start/end strings.
    let period: PeriodKey | null = null;
    if (tab.period != null) {
      if (
        typeof tab.period !== "string" ||
        !PERIOD_KEY_SET.has(tab.period as PeriodKey)
      ) {
        return null;
      }
      period = tab.period as PeriodKey;
    }
    // Validate each endpoint row rather than trusting the array
    // element-wise. A payload like `endpoints: [null]` would otherwise
    // pass the `Array.isArray` check and crash downstream consumers
    // (`buildEndpointChips`, the endpoint strip renderer) that spread
    // or destructure each entry. Reject the whole payload so the
    // caller falls back to the URL-driven default tab — the decoder
    // contract is "malformed → null", never "partial".
    let endpoints: EndpointEntry[] = [];
    if (tab.endpoints !== undefined) {
      if (!Array.isArray(tab.endpoints)) return null;
      const validated: EndpointEntry[] = [];
      for (const entry of tab.endpoints) {
        if (!isValidEndpointEntry(entry)) return null;
        validated.push(entry);
      }
      endpoints = validated;
    }
    // Rebuild `input.endpoints` from the separately-validated
    // `EndpointEntry[]` list instead of trusting whatever nested
    // `EndpointInput` shape may have been round-tripped through the
    // structured filter. Matches the `tabs=<json>` URL decoder — the
    // UI-side endpoint list is the source of truth for the endpoint
    // strip and owns the conversion into the GraphQL shape.
    let finalFilter = normalizedFilter;
    if (finalFilter.mode === "structured" && endpoints.length > 0) {
      finalFilter = {
        mode: "structured",
        input: {
          ...finalFilter.input,
          endpoints: endpointsToEndpointInputs(endpoints),
        },
      };
    }
    tabs.push({
      id: tab.id,
      filter: finalFilter,
      period,
      endpoints,
      pivotOnly:
        tab.pivotOnly && typeof tab.pivotOnly === "object" ? tab.pivotOnly : {},
      name: typeof tab.name === "string" ? tab.name : null,
      autoRun: tab.autoRun === true,
      analyticsOpen: tab.analyticsOpen === true,
    });
  }
  // Reject non-integer `activeIndex` values (e.g. `0.5`) instead of
  // clamping them. A fractional index survives `Math.max` / `Math.min`
  // unchanged, and the single-tab rehydrate path matches tabs by
  // `i === idx` — a fractional `idx` matches no slot, silently
  // dropping the URL's filter rebase and breaking "the URL is the
  // source of truth". Treat non-integers the same as other malformed
  // shapes.
  const rawIndex = candidate.activeIndex;
  if (
    rawIndex !== undefined &&
    (typeof rawIndex !== "number" || !Number.isInteger(rawIndex))
  ) {
    return null;
  }
  const activeIndex = Math.max(
    0,
    Math.min(tabs.length - 1, typeof rawIndex === "number" ? rawIndex : 0),
  );
  return { tabs, activeIndex };
}

function isValidEndpointEntry(value: unknown): value is EndpointEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Partial<EndpointEntry>;
  if (typeof e.id !== "string" || e.id.length === 0) return false;
  if (typeof e.raw !== "string") return false;
  if (e.kind !== "host" && e.kind !== "range" && e.kind !== "network") {
    return false;
  }
  if (
    e.direction !== "BOTH" &&
    e.direction !== "SOURCE" &&
    e.direction !== "DESTINATION"
  ) {
    return false;
  }
  if (typeof e.selected !== "boolean") return false;
  if (e.kind === "host" && typeof e.host !== "string") return false;
  if (e.kind === "network" && typeof e.network !== "string") return false;
  if (e.kind === "range") {
    const r = e.range;
    if (!r || typeof r !== "object") return false;
    if (typeof r.start !== "string" || typeof r.end !== "string") return false;
  }
  return true;
}

/**
 * Compare the shareable-state fingerprint of two tabs. Two tabs are
 * considered "the same tab" for the purpose of merging a URL-driven
 * rehydration with sessionStorage UI state when every persisted
 * shareable field matches — filter mode/input, the committed period,
 * the endpoint strip, any pivot-only URL params, and the
 * pending/committed `autoRun` flag (URL-encoded as `ar` / `pending=1`).
 * A mismatch means the stored tab at this slot describes a different
 * working set, and its manual rename / analytics-strip state must not
 * leak onto the URL-derived tab.
 *
 * Two normalizations happen before the comparison so the fingerprint
 * stays stable across the URL round-trip:
 *
 * - A relative-period tab (`period !== null`) has its structured
 *   `start` / `end` rolled to "now" on every load by
 *   {@link resolveTabPeriod}, so a URL-derived `Last 1 hour` tab and
 *   its sessionStorage twin will almost never share byte-identical
 *   timestamps. The timestamps are derivable from `period`, so they
 *   are excluded from the filter comparison when a period is set.
 * - URL-decoded endpoint rows get fresh synthetic ids
 *   (`endpoint-url-<n>`) while sessionStorage round-trips the
 *   original ids. The ids are client-only plumbing that never rides
 *   through the URL, so they are stripped from the endpoint
 *   comparison too.
 */
function sameTabFingerprint(a: TabSnapshot, b: TabSnapshot): boolean {
  return (
    a.period === b.period &&
    a.autoRun === b.autoRun &&
    stableStringify(normalizeFilterForFingerprint(a.filter, a.period)) ===
      stableStringify(normalizeFilterForFingerprint(b.filter, b.period)) &&
    stableStringify(normalizeEndpointsForFingerprint(a.endpoints)) ===
      stableStringify(normalizeEndpointsForFingerprint(b.endpoints)) &&
    stableStringify(a.pivotOnly) === stableStringify(b.pivotOnly)
  );
}

function normalizeFilterForFingerprint(
  filter: Filter,
  period: PeriodKey | null,
): Filter {
  if (filter.mode !== "structured" || period === null) return filter;
  // Strip the rolled timestamps — they are derivable from `period` and
  // drift across the URL round-trip (SSR clock read ≠ sessionStorage
  // write clock read).
  const { start: _s, end: _e, ...rest } = filter.input;
  return { mode: "structured", input: rest };
}

function normalizeEndpointsForFingerprint(
  endpoints: EndpointEntry[],
): Omit<EndpointEntry, "id">[] {
  return endpoints.map(({ id: _id, ...rest }) => rest);
}

/**
 * JSON.stringify with deterministic object-key ordering so
 * structurally identical objects serialize to identical strings
 * regardless of insertion order.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const keys = Object.keys(v as Record<string, unknown>).sort();
      const ordered: Record<string, unknown> = {};
      for (const key of keys) {
        ordered[key] = (v as Record<string, unknown>)[key];
      }
      return ordered;
    }
    return v;
  });
}

/**
 * Validate and normalize a session-stored `Filter`. Returns `null`
 * for unrecognisable shapes so the caller can reject the whole tab
 * set rather than ship malformed state back into interactive state.
 *
 * The structured branch uses the same field-level normalization the
 * `tabs=<json>` URL decoder applies (see
 * {@link ./filter-input-normalize.ts}): malformed scalars / arrays are
 * dropped silently and unknown keys are stripped. A tampered
 * sessionStorage payload like
 * `{ filter: { mode: "structured", input: { confidenceMin: "0.8oops",
 * levels: ["1junk"], categories: [1.5] } } }` now surfaces as a filter
 * with those fields absent instead of forwarding bad types into
 * `runEventQuery()` on the next auto-run.
 */
function normalizeSessionFilter(value: unknown): Filter | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { mode?: unknown };
  if (v.mode === "structured") {
    // `typeof null === "object"` in JS, so guard explicitly — a
    // `{ mode: "structured", input: null }` payload would otherwise
    // pass validation and then crash consumers that spread
    // `filter.input`.
    const input = (value as { input?: unknown }).input;
    if (input === null || typeof input !== "object") return null;
    return { mode: "structured", input: normalizeStructuredInput(input) };
  }
  if (v.mode === "query") {
    const text = (value as { text?: unknown }).text;
    if (typeof text !== "string") return null;
    return { mode: "query", text };
  }
  return null;
}

/**
 * Forward-compat `mode: "query"` filters round-trip through the URL
 * and sessionStorage decoders (see {@link ./filter.ts}) so the
 * persistence layer does not have to be rewritten when the search-
 * language UI lands. Today the live Detection page cannot actually
 * render them — there is no query editor, the chip bar returns no
 * chips for query mode, the drawer seeds a blank structured draft,
 * and `toEventListFilterInput` throws when it hits one. Any tab that
 * slips through the decoders as `mode: "query"` would therefore land
 * the page on an error state whose chip bar and drawer no longer
 * reflect the active tab's filter, breaking the issue's persistence /
 * reproduction contract.
 *
 * Downgrade such a tab to the default cold-start structured tab at
 * the page boundary. The tab id and operator-supplied name are
 * preserved so a local reload still tracks per-tab runtime caches;
 * everything else resets because a query-mode tab carries no
 * structured-side state to translate. When the search-language UI
 * ships, delete this helper and drop the page-boundary call sites.
 */
export function coerceTabForLivePage(
  tab: TabSnapshot,
  defaultPeriod: PeriodKey,
): TabSnapshot {
  if (tab.filter.mode === "structured") return tab;
  return {
    ...tab,
    filter: { mode: "structured", input: {} },
    period: defaultPeriod,
    endpoints: [],
    pivotOnly: {},
    autoRun: true,
  };
}

/**
 * Create a blank `+` tab with a default-period filter. The shell
 * does **not** auto-run the query for this tab — the operator must
 * Apply.
 */
export function createBlankTab(args: {
  filter: Filter;
  period: PeriodKey | null;
}): TabSnapshot {
  return {
    id: createTabId(),
    filter: args.filter,
    period: args.period,
    endpoints: [],
    pivotOnly: {},
    name: null,
    autoRun: false,
    analyticsOpen: false,
  };
}

/**
 * Create a fresh default tab that auto-runs its first query. Used on
 * page entry (cold start) and when the operator closes the last
 * remaining tab — both cases are "default tab" in the issue's sense,
 * not a pending `+` tab. The shell's auto-run effect fires the query
 * because `autoRun: true` and there is no cached result yet.
 */
export function createDefaultTab(args: {
  filter: Filter;
  period: PeriodKey | null;
}): TabSnapshot {
  return {
    id: createTabId(),
    filter: args.filter,
    period: args.period,
    endpoints: [],
    pivotOnly: {},
    name: null,
    autoRun: true,
    analyticsOpen: false,
  };
}

/**
 * Roll a tab's relative `period` forward to the current clock, returning
 * a snapshot whose structured `start` / `end` match the window the
 * operator-visible chip still claims (e.g. `Last 1 hour` really means
 * "the last hour ending now", not a frozen hour that was captured on
 * first Apply). Non-structured filters and tabs without a period are
 * returned unchanged.
 *
 * A tab with `period: null` and no explicit `start` / `end` is an
 * intentional "no time filter" state — either a pending `+` tab the
 * operator stripped before Applying, or a committed tab whose time
 * chip was removed via the chip bar's `×` affordance. Both must be
 * preserved: silently falling back to the default period here would
 * make the chip bar lie, because `×` on `Last 1 week` would visibly
 * snap back to `Last 1 hour`. Cold-start defaulting is handled
 * upstream in {@link ./page.tsx}'s `snapshotFromSingleTabUrl`, which
 * is the only place that actually needs to seed a default on a
 * genuinely empty URL.
 *
 * `now` defaults to `new Date()`; tests inject a fixed clock.
 */
export function resolveTabPeriod(tab: TabSnapshot, now?: Date): TabSnapshot {
  if (tab.filter.mode !== "structured") return tab;
  if (!tab.period) return tab;
  const input = tab.filter.input;
  const range = computePeriodRange(tab.period, now);
  if (input.start === range.start && input.end === range.end) return tab;
  const nextInput: EventListFilterInput = {
    ...input,
    start: range.start,
    end: range.end,
  };
  return { ...tab, filter: { mode: "structured", input: nextInput } };
}

/**
 * Rebase the stored tab set around the URL's tab snapshot. The URL
 * is the source of truth for shareable state; sessionStorage is
 * merged on top for the per-tab UI bits that never ride along on a
 * shared link.
 *
 * Two modes:
 *
 * 1. The URL carries the full tab set (`urlTabs.length > 1` — set
 *    via the `tabs=<json>` param when the working set fit inside
 *    the URL-length budget). The URL wins outright; session
 *    snapshots are only consulted to overlay UI state
 *    (`analyticsOpen`) and preserve tab ids / manual names when a
 *    session tab at the same index has a matching filter
 *    fingerprint. Index alone is not enough — opening someone
 *    else's shared URL in a browser that still has unrelated
 *    Detection session state would otherwise paint that operator's
 *    stale renames and analytics-strip expansion onto the shared
 *    tabs. The fingerprint gate makes sure we only inherit
 *    per-tab UI state when the tab is actually the same one.
 *
 * 2. The URL only describes the active tab (`urlTabs.length === 1`
 *    — either a shared link from a >1-tab operator whose set
 *    blew the budget, or a pivot-hand-off link). The stored tabs
 *    array is preserved; only the active slot's shareable state is
 *    rebased onto the URL.
 */
export function rehydrateTabs(args: {
  urlTabs: TabSnapshot[];
  urlActiveIndex: number | null;
  session: TabsSnapshot | null;
}): TabsSnapshot {
  const { urlTabs, urlActiveIndex, session } = args;
  if (urlTabs.length === 0) {
    // Defensive: callers always provide at least the SSR-derived tab.
    return session ?? { tabs: [], activeIndex: 0 };
  }

  if (urlTabs.length > 1) {
    // URL has the full set. Overlay session id / name / analyticsOpen
    // only when the session tab at the same index carries the same
    // filter fingerprint — a local reload of the author's own strip
    // still inherits rename + strip layout, but a recipient who opens
    // the shared URL in a browser with unrelated Detection session
    // state does not leak that operator's names / analytics state
    // onto the shared tabs.
    const activeIndex =
      urlActiveIndex !== null &&
      urlActiveIndex >= 0 &&
      urlActiveIndex < urlTabs.length
        ? urlActiveIndex
        : 0;
    const tabs = urlTabs.map((urlTab, i) => {
      const storedTab = session?.tabs[i];
      if (!storedTab) return urlTab;
      if (!sameTabFingerprint(urlTab, storedTab)) return urlTab;
      return {
        ...urlTab,
        // Keep the session's id so tab-keyed caches survive reload.
        id: storedTab.id,
        // Preserve an operator's manual rename when the URL's own
        // name slot is null (auto-generated).
        name: urlTab.name ?? storedTab.name,
        // UI-only state rides exclusively through sessionStorage.
        analyticsOpen: storedTab.analyticsOpen,
      };
    });
    return { tabs, activeIndex };
  }

  // Single-tab URL path — existing rebase behavior.
  const [urlTab] = urlTabs;
  if (!urlTab) return session ?? { tabs: [], activeIndex: 0 };
  if (!session || session.tabs.length === 0) {
    return { tabs: [urlTab], activeIndex: 0 };
  }
  // URL state is the source of truth for the active tab index. A
  // missing `?tab` on the single-tab URL path means the author's
  // active slot was 0 — `buildAllTabsSearchParams` deliberately omits
  // `?tab=0` (see {@link buildAllTabsSearchParams}) and the SSR
  // boundary already treats an absent/invalid `?tab` as 0 (see
  // {@link readActiveTabIndex} and the Detection page). Falling back
  // to `session.activeIndex` here would finish hydration on whichever
  // tab the local operator happened to have active, so opening an
  // active-only shared URL against a stored strip with a non-zero
  // `activeIndex` would land on the wrong tab (with the shared
  // filter silently rebased onto that slot instead of slot 0). Out-
  // of-range URL indices are treated the same way — clamp to 0
  // rather than resurrecting the local operator's active slot.
  const idx =
    urlActiveIndex !== null &&
    urlActiveIndex >= 0 &&
    urlActiveIndex < session.tabs.length
      ? urlActiveIndex
      : 0;
  // Replace the target tab's filter/period/endpoints/pivotOnly with
  // the URL's so a shared link wins, but keep the id + manual name +
  // UI state so a URL-scoped reload doesn't wipe operator context.
  //
  // The carry-over of stored id / name / analyticsOpen is fingerprint-
  // gated against the URL tab — same gate the multi-tab `tabs=<json>`
  // path uses (see {@link sameTabFingerprint}). Without the gate, an
  // active-only shared link that fell back from `tabs=<json>` because
  // the author's working set blew the URL budget would inherit the
  // recipient's stale rename / analytics-strip state from whatever
  // local tab happens to occupy `?tab=N`, even when the URL's filter
  // describes a completely different tab. That contradicts the
  // URL-vs-session split (shared shareable state must not pick up
  // private session UI state from an unrelated local tab).
  const storedTarget = session.tabs[idx];
  const fingerprintMatches =
    storedTarget !== undefined && sameTabFingerprint(urlTab, storedTarget);
  const rebased = session.tabs.map((t, i) => {
    if (i !== idx) return t;
    if (!fingerprintMatches) {
      // The URL describes a different tab than the local slot: take
      // the URL's id / null name / collapsed analytics strip rather
      // than leaking the local operator's private UI state onto a
      // shared filter.
      return urlTab;
    }
    return {
      ...t,
      filter: urlTab.filter,
      period: urlTab.period,
      endpoints: urlTab.endpoints,
      pivotOnly: urlTab.pivotOnly,
      autoRun: urlTab.autoRun,
    };
  });
  return { tabs: rebased, activeIndex: idx };
}
