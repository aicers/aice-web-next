/**
 * `sessionStorage` persistence for Detection multi-tab state (Phase
 * Detection-10). See `src/lib/detection/tabs.ts` for the high-level
 * persistence split between URL (shareable) and sessionStorage
 * (private).
 *
 * What rides here:
 * - Every tab's id, name, `manualName`, filter, committed period,
 *   endpoints, pivot-only URL fields, pagination, drawer draft,
 *   and analytics-strip expansion.
 * - The active tab id.
 *
 * What does NOT ride here:
 * - Result rows and pagination connection info. sessionStorage has
 *   a ~5 MB quota and a populated result page can carry megabytes
 *   on its own — persisting N tabs' worth of events would risk a
 *   quota exception every Apply. The shell sets `hasQueried: false`
 *   on rehydrated inactive tabs so the operator sees the pre-query
 *   empty state and clicks Apply to populate. Refresh is intentionally
 *   disabled in that state (matching the `+`-affordance "no auto-run"
 *   contract from #281), so the first post-rehydrate query for an
 *   inactive tab always goes through Apply.
 * - The Quick peek selection (held on the URL via `?event=`, scoped
 *   to the active tab).
 * - The Reviewer Round 9 pending Quick peek token (transient
 *   bootstrap-only signal; the URL itself is the source of truth on
 *   rehydration, so the token is recomputed by the page on the next
 *   reload from the URL).
 *
 * Schema versioning: payloads are tagged with a `version` literal;
 * the deserializer drops any payload whose version does not match
 * the current spec rather than attempting an in-place migration.
 * On a version bump, the session for an existing operator resets
 * to the default single tab — the trade-off is simpler code at
 * the cost of a one-time reset, which is acceptable for a
 * private session-scoped store.
 */

import {
  type AnalyticsDimension,
  type AnalyticsTopN,
  isAnalyticsDimension,
  isAnalyticsTopN,
} from "./analytics";
import type { EndpointEntry } from "./endpoint-filter";
import type { Filter } from "./filter";
import type { DetectionFilterDraft } from "./filter-draft";
import type { PaginationState } from "./pagination";
import type { PeriodKey } from "./period";
import { EMPTY_RESULT_CACHE, type TabId, type TabSnapshot } from "./tabs";
import type { PivotFilterParams } from "./url-filters";

export const STORAGE_KEY_PREFIX = "detection:tabs:v1";
const PAYLOAD_VERSION = 1 as const;

/**
 * Per-scope `sessionStorage` key. `sessionStorage` survives sign-out /
 * sign-in in the same browser tab, so a fixed key would let account A's
 * tab UX state surface to account B (or to the same account after a
 * customer-assignment change). Namespacing the key by the scope
 * fingerprint isolates each (account, customerIds) pairing into its
 * own slot — a sign-in under a different scope reads `null` and falls
 * back to the URL-only bootstrap tab. (#393 Task C)
 *
 * `null` fingerprint means the caller is not yet inside the
 * `ScopeFingerprintProvider` (e.g. tests, storybook, or a sign-out path
 * still rendering layout shell). In that mode every storage operation
 * is a no-op so the previous account's payload cannot be read or
 * written.
 */
export function tabsStorageKey(fingerprint: string | null): string | null {
  if (!fingerprint) return null;
  return `${STORAGE_KEY_PREFIX}:${fingerprint}`;
}

/**
 * Stripped-down per-tab shape written to sessionStorage. Mirrors
 * {@link TabSnapshot} minus the `result` cache.
 */
interface StoredTab {
  id: TabId;
  name: string | null;
  manualName: boolean;
  filter: Filter;
  period: PeriodKey | null;
  endpoints: EndpointEntry[];
  pivotOnly: PivotFilterParams;
  pagination: PaginationState;
  draft: DetectionFilterDraft | null;
  analyticsOpen: boolean;
  /**
   * The dimension currently shown in the analytics strip's selector
   * (Reviewer Round 1, P2 per-tab state). Required: a tab missing or
   * carrying an invalid value is dropped like any other structurally
   * invalid tab, per the module's drop-don't-migrate policy.
   */
  analyticsDimension: AnalyticsDimension;
  /** See {@link analyticsDimension}. */
  analyticsTopN: AnalyticsTopN;
}

interface StoredPayload {
  version: typeof PAYLOAD_VERSION;
  activeTabId: TabId;
  tabs: StoredTab[];
}

function toStoredTab(tab: TabSnapshot): StoredTab {
  return {
    id: tab.id,
    name: tab.name,
    manualName: tab.manualName,
    filter: tab.filter,
    period: tab.period,
    endpoints: tab.endpoints,
    pivotOnly: tab.pivotOnly,
    pagination: tab.pagination,
    draft: tab.draft,
    analyticsOpen: tab.analyticsOpen,
    analyticsDimension: tab.analyticsDimension,
    analyticsTopN: tab.analyticsTopN,
  };
}

/**
 * Promote a stored tab back into a full {@link TabSnapshot}. Result
 * cache is intentionally empty — see the module-level comment.
 */
function hydrateStoredTab(stored: StoredTab): TabSnapshot {
  return {
    ...stored,
    quickPeekEvent: null,
    pendingQuickPeekToken: null,
    result: EMPTY_RESULT_CACHE,
    // Issue #429: matching state is intentionally not persisted. A
    // reload resets every rehydrated tab to "manual + custom" so the
    // first preset activation after reload always creates a new tab —
    // the operator hasn't told us their previous tab was the preset
    // tab they want to focus, and silently treating it as one would
    // surprise them when subsequent clicks suddenly stop spawning new
    // tabs.
    originPreset: null,
    timeMode: "custom",
    lastActivatedAt: Date.now(),
  };
}

export function serializeTabsForStorage(
  tabs: readonly TabSnapshot[],
  activeTabId: TabId,
): string {
  const payload: StoredPayload = {
    version: PAYLOAD_VERSION,
    activeTabId,
    tabs: tabs.map(toStoredTab),
  };
  return JSON.stringify(payload);
}

export interface DeserializedTabs {
  activeTabId: TabId;
  tabs: TabSnapshot[];
}

/**
 * Decode a stored payload. Returns `null` on any structural
 * mismatch so the caller can fall back to the URL-only bootstrap
 * tab rather than rehydrating a corrupted payload.
 */
export function deserializeTabsFromStorage(
  raw: string | null,
): DeserializedTabs | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { version?: unknown }).version !== PAYLOAD_VERSION ||
    !Array.isArray((parsed as { tabs?: unknown }).tabs) ||
    typeof (parsed as { activeTabId?: unknown }).activeTabId !== "string"
  ) {
    return null;
  }
  const payload = parsed as StoredPayload;
  const tabs: TabSnapshot[] = [];
  for (const candidate of payload.tabs) {
    if (!isStoredTab(candidate)) continue;
    tabs.push(hydrateStoredTab(candidate));
  }
  if (tabs.length === 0) return null;
  const activeTabId = tabs.some((t) => t.id === payload.activeTabId)
    ? payload.activeTabId
    : tabs[0].id;
  return { activeTabId, tabs };
}

function isStoredTab(candidate: unknown): candidate is StoredTab {
  if (!candidate || typeof candidate !== "object") return false;
  const c = candidate as Partial<StoredTab>;
  return (
    typeof c.id === "string" &&
    (c.name === null || typeof c.name === "string") &&
    typeof c.manualName === "boolean" &&
    !!c.filter &&
    typeof c.filter === "object" &&
    Array.isArray(c.endpoints) &&
    !!c.pagination &&
    typeof c.pagination === "object" &&
    isAnalyticsDimension(c.analyticsDimension) &&
    isAnalyticsTopN(c.analyticsTopN)
  );
}

/**
 * Load the saved tabs payload from `sessionStorage`. A best-effort
 * read — absence, quota errors, or a corrupted payload all fold
 * into `null` and the caller falls back to the URL-only bootstrap.
 *
 * `fingerprint` namespaces the key by `(accountId, customerIds)` so a
 * sign-out / sign-in or scope swap in the same browser tab cannot
 * surface another scope's saved tab UX state. A `null` fingerprint
 * (no provider) skips the read entirely.
 */
export function readTabsFromSession(
  fingerprint: string | null,
): DeserializedTabs | null {
  if (typeof window === "undefined") return null;
  const key = tabsStorageKey(fingerprint);
  if (!key) return null;
  try {
    return deserializeTabsFromStorage(window.sessionStorage.getItem(key));
  } catch {
    return null;
  }
}

/**
 * Write the current tab set to `sessionStorage`. Silently ignores
 * quota / privacy-mode errors — the result is the same as never
 * having written: on reload we fall back to the URL-only bootstrap,
 * which is preferable to crashing the whole shell render.
 *
 * See {@link readTabsFromSession} for the `fingerprint` contract.
 */
export function writeTabsToSession(
  tabs: readonly TabSnapshot[],
  activeTabId: TabId,
  fingerprint: string | null,
): void {
  if (typeof window === "undefined") return;
  const key = tabsStorageKey(fingerprint);
  if (!key) return;
  try {
    window.sessionStorage.setItem(
      key,
      serializeTabsForStorage(tabs, activeTabId),
    );
  } catch {
    // sessionStorage.setItem throws under quota or privacy modes.
    // Dropping the write matches "best-effort persistence" — a
    // reload loses the inactive tabs but the active tab is still
    // recoverable from the URL.
  }
}

/**
 * Drop the stored tab payload. Used by tests and any future
 * "Reset tabs" affordance.
 */
export function clearTabsFromSession(fingerprint: string | null): void {
  if (typeof window === "undefined") return;
  const key = tabsStorageKey(fingerprint);
  if (!key) return;
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Ignored — see `writeTabsToSession`.
  }
}
