"use client";

/**
 * Stories list + detail container (#490).
 *
 * Renders a server-supplied list of {@link TriageStory} rows as cards,
 * with an optional focused-Story detail panel beneath. The detail
 * panel's member table is rendered by the shared
 * `TriageEventTable` in `src/components/triage/event-row/triage-event-table.tsx`
 * (extracted in #554); this file only normalizes Story member rows
 * into the shared `TriageEventRow` view-model and supplies the
 * Story-only `origAddr` / `respAddr` column labels.
 *
 * The Send-to-aimer-web button on each card is the inert
 * `disabled=true` shape #490 ships; #493 takes over the click
 * handler and the disabled-state flip.
 *
 * Sort: default `time_window_end DESC` (the server already sorts
 * cross-tenant on this key). Optional in-component sort toggle
 * `score DESC` — the rows stay stable across both orderings because
 * the secondary key is always `(customerId, storyId)`.
 */

import { useEffect, useMemo, useRef, useState, useTransition } from "react";

import type { AiAnalysisStorySummaryFetcher } from "@/lib/aimer/analysis/story-summary.client";
import type { AiAnalysisStorySummary } from "@/lib/aimer/analysis/summary-types";
import {
  ManualSendError,
  manualSendToAimerWeb,
} from "@/lib/aimer/phase2/manual-send.client";
import {
  createPeriodicDrain,
  type PeriodicDrainController,
} from "@/lib/aimer/phase2/transport.client";
import type { TriagePeriod } from "@/lib/triage";
import type { PivotDimensionId, PivotValue } from "@/lib/triage/pivot";
import { getPivotDimension } from "@/lib/triage/pivot";
import { storyMemberToScoredEvent } from "@/lib/triage/story/pivot-adapter";
import type {
  StoriesSortOrder,
  TriageStory,
  TriageStoryMemberDetail,
} from "@/lib/triage/story/types";

import {
  type ProtectedByStoryMarkerLabels,
  renderProtectedByStoryMarker,
} from "../event-row/protected-by-story-marker";
import {
  type TriageEventRow,
  TriageEventTable,
  type TriageEventTableLabels,
} from "../event-row/triage-event-table";
import { renderAiAnalysisBadge } from "./ai-analysis-badge";
import { TriageStoryCard, type TriageStoryCardLabels } from "./story-card";
import { renderStoryTitle } from "./story-title";

export type { StoriesSortOrder };

/**
 * Maximum in-flight AI-analysis summary requests dispatched from
 * the Stories view (#645). The Stories page caps at 200 rows; a
 * naive per-card fetch can therefore fan out 200 simultaneous
 * internal requests (and 200 onward requests against aimer-web).
 * The cap is set conservatively in the 6–8 range called out by
 * the issue's "Fetch fan-out and concurrency" section.
 *
 * Exported for tests that need to assert the limit is respected.
 */
export const AI_ANALYSIS_MAX_IN_FLIGHT = 6;

/**
 * Server-action seam for refetching the Stories list with new sort /
 * filter options. Returns `null` on session lapse / unexpected error
 * — the view keeps the previously-rendered slice in that case.
 */
export type StoriesRefresh = (options: {
  sortOrder: StoriesSortOrder;
  unsentOnly: boolean;
}) => Promise<{
  stories: ReadonlyArray<TriageStory>;
  truncated: boolean;
} | null>;

/**
 * Client-callable seam for the full member-detail fetch
 * (`fetchStoryDetail` in `story-actions.ts`). Kept as a prop so
 * the component is unit-testable without standing up a Next dev
 * server. Returns `null` on session lapse / out-of-scope / error;
 * the detail panel renders the empty-state copy in that case.
 */
export type StoryDetailLoader = (args: {
  customerId: number;
  storyId: string;
  storedMemberCount: number;
}) => Promise<{
  members: TriageStoryMemberDetail[];
  hasDanglingMembers: boolean;
  storedMemberCount: number;
} | null>;

export interface TriageStoriesViewLabels {
  heading: string;
  /** Surfaced when the period overlap yields zero stories. */
  empty: string;
  /** Surfaced when the server truncated the per-tenant page. */
  truncatedTemplate: string;
  /** Surfaced when the user toggled "Show only unsent" and no rows remain. */
  emptyUnsentOnly: string;
  showOnlyUnsentLabel: string;
  sortLabel: string;
  sortByTimeWindowEnd: string;
  sortByScore: string;
  card: TriageStoryCardLabels;
  detail: TriageStoryDetailLabels;
  /** Surfaced when the URL hash carried a bare `storyId` with no `customerId/`. */
  staleHashFallback: string;
}

export interface TriageStoryDetailLabels {
  heading: string;
  emptySelection: string;
  emptyMembers: string;
  customerLabel: string;
  scoreLabel: string;
  ruleLabel: string;
  /** Template for the dangling-member notice. `{shown}` / `{stored}` / `{aged}`. */
  danglingNoticeTemplate: string;
  timeColumn: string;
  kindColumn: string;
  categoryColumn: string;
  scoreColumn: string;
  /** Optional column heading for the member's source address. */
  origAddrColumn?: string;
  /** Optional column heading for the member's destination address. */
  respAddrColumn?: string;
  /** Surfaced while the full member list is being fetched. */
  loading: string;
  close: string;
  /**
   * Pivot-from-Story affordances (#553). Required only when the
   * Stories view receives an `onPivotFromStory` callback — the
   * actions column collapses out without these labels.
   */
  pivotActionsColumn?: string;
  /**
   * Template for the per-button accessible label: `{dimension}`
   * (localized dimension name) and `{value}` (the value text).
   */
  pivotActionTemplate?: string;
  /**
   * Map of dimension id → localized name. Same shape as the Pivot
   * panel's `labels.dimensions` so the breadcrumb and the row actions
   * stay in sync.
   */
  pivotDimensions?: Record<PivotDimensionId, string>;
  /**
   * Story-protected row marker copy (#471 §3). Parameterized by
   * `{score}`. Rendered at the start of a member row's leading cell
   * when the member carries `protectedByStory === true`. Optional —
   * surfaces that have not yet wired the slider into the Story view
   * leave it undefined and the marker collapses out.
   */
  protectedByStoryMarker?: ProtectedByStoryMarkerLabels;
}

interface TriageStoriesViewProps {
  stories: ReadonlyArray<TriageStory>;
  truncated: boolean;
  /**
   * Authorization-derived in-scope customer ids (#493). One
   * `createPeriodicDrain("story", customerId, …)` controller is
   * mounted per customer in this list. The set MUST be derived
   * server-side from `resolveEffectiveCustomerIds(...)` (not from
   * `stories[]`) so a customer whose Stories are filtered out of
   * the visible page still has its `withdraw_story` /
   * `refresh_story_window` / `backfill_story_window` queue drained.
   */
  inScopeCustomerIds?: readonly number[];
  /**
   * Server-resolved `{ configured }` flag from
   * {@link getAimerIntegrationSetupStatus}. When `false`, every Story
   * card's Send button (and the kebab "Send (force refresh)" menu)
   * stays disabled with the explanatory tooltip — manual sends would
   * otherwise reach the route only to fail at the mint step on a
   * missing `aice_id`, bridge URL, or active signing key.
   *
   * Defaults to `false` so unit-test paths that omit the prop see the
   * grey-out shape rather than a falsely-enabled button.
   */
  aimerIntegrationConfigured?: boolean;
  /**
   * Focused story (controlled). The container surfaces the detail
   * panel for this row; `null` shows just the list.
   */
  focused: TriageStory | null;
  onFocus: (story: TriageStory | null) => void;
  /** Surface the stale-hash toast when the URL carried a bad story id. */
  showStaleHashWarning?: boolean;
  /**
   * The menu's current period — forwarded to {@link loadDetail} so
   * the read-time `baseline_score` cohort matches the menu's
   * cohort. Optional only because some unit tests render the view
   * without seeding the loader.
   */
  period?: TriagePeriod;
  /**
   * Server-action loader for the full member detail table. When
   * absent the detail panel falls back to the list-time top-3
   * preview so the component is still useful in unit tests.
   */
  loadDetail?: StoryDetailLoader;
  /**
   * Server-action loader for re-fetching the list with new sort and
   * unsent-only options. The toggles push these axes into SQL so a
   * tenant with more overlapping Stories than {@link TRIAGE_STORY_PAGE_SIZE}
   * does not silently scope sort / filter to a stale first page.
   * When absent, the toggles fall back to client-side reordering of
   * the prop list (useful in unit tests).
   */
  refreshStories?: StoriesRefresh;
  /**
   * Pivot-from-Story (#553) handler. Fired when the analyst clicks a
   * pivot dimension button on a Story member event row in the detail
   * panel. The view passes the focused Story (so the caller can seed
   * the Pivot-origin marker) along with the full member-detail list
   * (so the caller can build the pivot index over the Story's events
   * as documented in #553 §"Pivot corpus shape from a Story").
   */
  /**
   * AI narrative analysis summary fetcher (#645). When supplied, the
   * view fetches one summary per visible Story on mount / list
   * rotation and forwards it to both the card header and the detail
   * panel. Absent fetcher = no badge anywhere; the seam keeps the
   * component unit-testable without standing up the internal route.
   *
   * Fan-out is one request per visible row (the page caps at 200);
   * a bounded-concurrency / lazy-viewport / batch-endpoint
   * optimization is documented as the next step before the #646
   * dashboard surface reuses the badge.
   */
  loadAiAnalysis?: AiAnalysisStorySummaryFetcher;
  onPivotFromStory?: (args: {
    story: TriageStory;
    members: readonly TriageStoryMemberDetail[];
    /**
     * The Story member whose pivot button was clicked. The Phase 1
     * engagement-signal capture (#588) attributes `story_pivot_click`
     * to this row's `eventKey` / `kind` / `baselineVersion` — using
     * `members[0]` instead would mis-attribute the action to a
     * different member than the analyst actually clicked.
     */
    member: TriageStoryMemberDetail;
    dimension: PivotDimensionId;
    value: PivotValue;
  }) => void;
  labels: TriageStoriesViewLabels;
}

export function TriageStoriesView({
  stories,
  truncated,
  inScopeCustomerIds = [],
  aimerIntegrationConfigured = false,
  focused,
  onFocus,
  showStaleHashWarning,
  period,
  loadDetail,
  refreshStories,
  loadAiAnalysis,
  onPivotFromStory,
  labels,
}: TriageStoriesViewProps) {
  const [sortOrder, setSortOrder] =
    useState<StoriesSortOrder>("time-window-end");
  const [unsentOnly, setUnsentOnly] = useState<boolean>(false);
  // When the server-action refresh seam is wired, hold the most
  // recent server-returned slice locally so a sort/filter toggle
  // replaces the prop-loaded slice without a full page navigation.
  // The initial value tracks the props so the first render uses the
  // server-component-loaded data.
  const [serverStories, setServerStories] = useState<{
    stories: ReadonlyArray<TriageStory>;
    truncated: boolean;
  } | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const lastPropsRef = useRef<ReadonlyArray<TriageStory>>(stories);
  // Monotonic request id for in-flight refresh ordering. A quick
  // sort-toggle → unsent-toggle sequence dispatches two refreshes; if
  // the older one resolves second we must NOT overwrite the newer
  // response. Each dispatch increments `nextRequestIdRef` and the
  // resolver compares its tag against the latest dispatched id before
  // committing the result. This is more robust than disabling the
  // controls during a refresh: the user can still queue a second
  // toggle before the first finishes (the `useTransition` `disabled`
  // is best-effort UX, not a state-ordering guarantee).
  const nextRequestIdRef = useRef<number>(0);
  const latestRequestIdRef = useRef<number>(0);
  // Track the latest `focused` prop so the refresh resolver reconciles
  // against the focus *at commit time*, not the one captured when the
  // refresh was dispatched. The list stays interactive during a
  // refresh, so the focus can rotate (or appear / disappear) between
  // dispatch and resolve; reading the prop through a ref avoids
  // mis-clearing the new focus or leaving a now-absent focus stuck.
  // Sync the ref during render (not in an effect) so a focus rerender
  // makes the new value visible to any refresh resolver that fires
  // before passive effects have flushed.
  const focusedRef = useRef<TriageStory | null>(focused);
  focusedRef.current = focused;
  // When the prop list rotates (period change, post-save refresh,
  // mode toggle, etc.), drop the locally-held server-action slice so
  // we render the freshly-loaded server data instead of stale
  // refresh state. Identity check is sufficient — the parent uses a
  // memoized array reference per server response.
  useEffect(() => {
    if (lastPropsRef.current !== stories) {
      lastPropsRef.current = stories;
      setServerStories(null);
      // Invalidate any in-flight refresh: a prop rotation supersedes
      // every queued response, just like a newer toggle does. We bump
      // `nextRequestIdRef` *before* writing `latestRequestIdRef` so the
      // tag carried by any in-flight resolver (which closed over the
      // pre-bump value) compares strictly less-than `latestRequestIdRef`
      // and is dropped on commit. Without the bump the in-flight tag
      // would equal `latestRequestIdRef.current` and the resolver would
      // still overwrite the freshly-rotated prop slice.
      nextRequestIdRef.current += 1;
      latestRequestIdRef.current = nextRequestIdRef.current;
    }
  }, [stories]);

  const refresh = (next: {
    sortOrder: StoriesSortOrder;
    unsentOnly: boolean;
  }) => {
    if (!refreshStories) return;
    nextRequestIdRef.current += 1;
    const requestId = nextRequestIdRef.current;
    latestRequestIdRef.current = requestId;
    startRefresh(() => {
      void refreshStories(next).then((result) => {
        if (result === null) return;
        // Drop the response when a newer toggle (or prop rotation)
        // has already superseded this request — committing it would
        // overwrite the user-visible state with a stale slice.
        if (requestId !== latestRequestIdRef.current) return;
        setServerStories({
          stories: result.stories,
          truncated: result.truncated,
        });
        // The parent reconciles focus against the `stories` prop, but
        // a SQL-side refresh rotates the effective list inside this
        // view without touching the prop. If the focused Story is
        // absent from the refreshed slice (e.g. analyst opened a sent
        // Story, then enabled "Show only unsent"), clear focus so
        // the detail panel and the URL hash do not drift out of sync
        // with the filtered list. Reconcile against `focusedRef` —
        // the focus may have rotated (or been opened from null) while
        // the response was in flight, and the closed-over `focused`
        // would mis-clear the newly-focused Story or leave a stale
        // one in place.
        const focusAtCommit = focusedRef.current;
        if (focusAtCommit !== null) {
          const stillPresent = result.stories.some(
            (s) =>
              s.customerId === focusAtCommit.customerId &&
              s.storyId === focusAtCommit.storyId,
          );
          if (!stillPresent) onFocus(null);
        }
      });
    });
  };

  const effectiveStories = serverStories?.stories ?? stories;
  const effectiveTruncated = serverStories?.truncated ?? truncated;

  // Local overrides for the β-tracking indicator (#493). A successful
  // manual Send updates `lastSentAtIso` / `sendCount` on this map so
  // the card re-renders immediately without waiting for the full
  // menu refresh. Keyed by `"{customerId}/{storyId}"`.
  const [betaOverrides, setBetaOverrides] = useState<
    Record<string, { lastSentAtIso: string; sendCount: number }>
  >({});
  const overrideStory = (story: TriageStory): TriageStory => {
    const key = `${story.customerId}/${story.storyId}`;
    const override = betaOverrides[key];
    if (!override) return story;
    return {
      ...story,
      lastSentAtIso: override.lastSentAtIso,
      sendCount: override.sendCount,
    };
  };

  // AI narrative analysis summaries per Story (#645). Keyed by
  // `"{customerId}/{storyId}"`. Absent entry = not yet resolved or
  // resolved to "no badge" — both render the same way (no badge), so
  // the map only needs to remember positive hits.
  //
  // Fetches go through a bounded-concurrency queue
  // (`AI_ANALYSIS_MAX_IN_FLIGHT`) so the 200-row Stories cap cannot
  // fan out into 200 simultaneous internal requests (and 200 onward
  // requests against aimer-web). A previously-resolved
  // (customerId, storyId) is not re-queued on rotation — the
  // upstream summary is keyed on the same pair so the cached value
  // is still authoritative. A sort/filter rotation that brings the
  // same Story back into view therefore stays free.
  //
  // The active-count and "current scheduler" pointers live in refs
  // that **persist across effect generations**, not in the closure of
  // any single effect run. If they were closure-local, a list
  // rotation to a different visible set could stack a second batch
  // of `AI_ANALYSIS_MAX_IN_FLIGHT` requests on top of the old
  // effect's still-running requests, because the new effect's local
  // `active` would start at `0` and the new keys would not appear
  // in `aiInFlightRef`. The shared `aiActiveCountRef` ensures every
  // generation observes the same global cap; `aiSchedulerRef` lets
  // a stale generation's `.finally` hook drain the **current**
  // generation's queue as each slot frees up.
  //
  // `aiSummaries` is read through `aiSummariesRef`, not the dep
  // array: including the state in the deps would re-run the effect
  // on every successful resolution and the cleanup would race with
  // each pending fetch — turning a planned O(N) fan-out into O(N²)
  // request amplification.
  //
  // In-flight fetches are intentionally **not** aborted when the
  // effect re-runs (sort / filter / unsent-only toggle). The
  // (customerId, storyId) cache key is stable across rotations, so a
  // result already on the wire is still useful and storing it in
  // `aiSummariesRef` prevents the next effect run from re-queuing
  // the same key. Aborting active requests and only releasing queued
  // reservations would leave the active keys stuck in `aiInFlightRef`
  // past the next effect setup (which skips reserved keys) and only
  // released them on the aborted `.finally` — by which point no
  // effect run would re-queue them, so still-visible Stories could
  // silently lose their badge.
  const [aiSummaries, setAiSummaries] = useState<
    Record<string, AiAnalysisStorySummary>
  >({});
  const aiInFlightRef = useRef<Set<string>>(new Set());
  const aiActiveCountRef = useRef(0);
  const aiSchedulerRef = useRef<(() => void) | null>(null);
  const aiSummariesRef = useRef(aiSummaries);
  aiSummariesRef.current = aiSummaries;
  useEffect(() => {
    if (!loadAiAnalysis) return;
    let cancelled = false;
    const queue: TriageStory[] = [];
    for (const story of effectiveStories) {
      const key = `${story.customerId}/${story.storyId}`;
      if (aiInFlightRef.current.has(key)) continue;
      if (Object.hasOwn(aiSummariesRef.current, key)) continue;
      // Reserve the key up-front so a concurrent effect run on a
      // sort/filter rotation does not enqueue the same Story twice.
      aiInFlightRef.current.add(key);
      queue.push(story);
    }
    const startNext = () => {
      if (cancelled) return;
      while (
        aiActiveCountRef.current < AI_ANALYSIS_MAX_IN_FLIGHT &&
        queue.length > 0
      ) {
        const story = queue.shift();
        if (!story) break;
        const key = `${story.customerId}/${story.storyId}`;
        aiActiveCountRef.current += 1;
        void loadAiAnalysis({
          customerId: story.customerId,
          storyId: story.storyId,
        })
          .then((summary) => {
            if (summary === null) return;
            setAiSummaries((prev) =>
              Object.hasOwn(prev, key) ? prev : { ...prev, [key]: summary },
            );
          })
          .catch(() => {
            // fetchAiAnalysisStorySummary already normalizes errors
            // to null — a thrown error here only happens on a
            // synchronous bug in the caller-supplied fetcher and
            // should not be surfaced to the operator.
          })
          .finally(() => {
            aiInFlightRef.current.delete(key);
            aiActiveCountRef.current -= 1;
            // Kick the **current** scheduler, not necessarily ours.
            // A stale generation whose effect has already been
            // cancelled must still hand the freed slot to whichever
            // effect generation is now live, so its queue can drain
            // up to the global cap.
            aiSchedulerRef.current?.();
          });
      }
    };
    aiSchedulerRef.current = startNext;
    startNext();
    return () => {
      // Stop the queue from spawning new requests; let already
      // in-flight fetches complete and populate the (customerId,
      // storyId)-keyed cache as normal. Anything still queued is
      // released so the next effect run re-queues it. We do not
      // clear `aiSchedulerRef` — the next effect overwrites it, and
      // if the component is unmounting the `cancelled` guard keeps
      // any late `.finally` callback inert.
      cancelled = true;
      for (const story of queue) {
        aiInFlightRef.current.delete(`${story.customerId}/${story.storyId}`);
      }
    };
  }, [effectiveStories, loadAiAnalysis]);

  // Toast state for the "Sent to aimer-web" / error notifications.
  const [toast, setToast] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  // Per-customer periodic drain mount (#493). One controller per
  // customer in `inScopeCustomerIds` — independent of which stories
  // are visible. The drain auto-pauses on `visibilitychange` →
  // hidden via the Foundation controller.
  //
  // `inScopeCustomerIds` is sorted + serialized into a stable key
  // first so the effect does not re-mount on array-reference
  // rotation alone (the customer set rarely changes; the array
  // reference does on every parent re-render). The customer list
  // is reconstructed from the key inside the effect to keep React's
  // dependency-array contract simple and avoid stale closures.
  const inScopeKey = inScopeCustomerIds
    .slice()
    .sort((a, b) => a - b)
    .join(",");
  useEffect(() => {
    if (inScopeKey === "") return;
    const customerIds = inScopeKey
      .split(",")
      .map((s) => Number.parseInt(s, 10));
    const controllers = new Map<number, PeriodicDrainController>();
    for (const customerId of customerIds) {
      const controller = createPeriodicDrain("story", customerId, {
        intervalMs: 5 * 60 * 1000,
      });
      controllers.set(customerId, controller);
      controller.start();
    }
    return () => {
      for (const controller of controllers.values()) {
        controller.stop();
      }
    };
  }, [inScopeKey]);

  const handleSend = async ({
    story,
    forceRefresh,
  }: {
    story: TriageStory;
    forceRefresh: boolean;
  }) => {
    try {
      const result = await manualSendToAimerWeb({
        customerId: story.customerId,
        storyId: story.storyId,
        forceRefresh,
      });
      setBetaOverrides((prev) => ({
        ...prev,
        [`${story.customerId}/${story.storyId}`]: {
          lastSentAtIso: result.lastSentAtIso,
          sendCount: result.sendCount,
        },
      }));
      setToast({
        kind: "success",
        message: labels.card.sendSuccessToast,
      });
    } catch (err) {
      const reason =
        err instanceof ManualSendError
          ? (err.code ?? err.message)
          : err instanceof Error
            ? err.message
            : "unknown";
      setToast({
        kind: "error",
        message: `${labels.card.sendErrorPrefix} ${reason}`,
      });
    }
  };

  // When the server-action seam is unavailable (unit-test path), fall
  // back to client-side filter/sort against the prop slice so the
  // component is still functional. This is the same behavior the
  // pre-server-action path used; the production code path now hits
  // the SQL-side ORDER BY / WHERE through {@link refresh}.
  const filtered = useMemo(() => {
    if (refreshStories) return effectiveStories;
    const rows: TriageStory[] = unsentOnly
      ? effectiveStories.filter((s) => s.lastSentAtIso === null)
      : [...effectiveStories];
    if (sortOrder === "score") {
      rows.sort((a, b) => {
        const aScore = a.score ?? 0;
        const bScore = b.score ?? 0;
        if (aScore !== bScore) return bScore - aScore;
        if (a.timeWindowEndIso !== b.timeWindowEndIso) {
          return b.timeWindowEndIso.localeCompare(a.timeWindowEndIso);
        }
        if (a.customerId !== b.customerId) return a.customerId - b.customerId;
        return a.storyId.localeCompare(b.storyId);
      });
    }
    return rows;
  }, [effectiveStories, unsentOnly, sortOrder, refreshStories]);

  return (
    <section
      aria-label={labels.heading}
      className="flex flex-col gap-4"
      data-testid="triage-stories-view"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-foreground">
          {labels.heading}
        </h2>
        <div className="flex items-center gap-3 text-xs">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={unsentOnly}
              disabled={refreshing}
              onChange={(e) => {
                const next = e.currentTarget.checked;
                setUnsentOnly(next);
                refresh({ sortOrder, unsentOnly: next });
              }}
              data-testid="triage-stories-unsent-only"
            />
            <span>{labels.showOnlyUnsentLabel}</span>
          </label>
          <label className="flex items-center gap-1">
            <span className="text-muted-foreground">{labels.sortLabel}</span>
            <select
              value={sortOrder}
              disabled={refreshing}
              onChange={(e) => {
                const next = e.currentTarget.value as StoriesSortOrder;
                setSortOrder(next);
                refresh({ sortOrder: next, unsentOnly });
              }}
              data-testid="triage-stories-sort"
              className="rounded-sm border border-border bg-background px-2 py-0.5"
            >
              <option value="time-window-end">
                {labels.sortByTimeWindowEnd}
              </option>
              <option value="score">{labels.sortByScore}</option>
            </select>
          </label>
        </div>
      </header>
      {showStaleHashWarning ? (
        <p
          role="status"
          data-testid="triage-stories-stale-hash"
          className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200"
        >
          {labels.staleHashFallback}
        </p>
      ) : null}
      {effectiveTruncated ? (
        <p className="text-xs text-muted-foreground">
          {labels.truncatedTemplate}
        </p>
      ) : null}
      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {unsentOnly ? labels.emptyUnsentOnly : labels.empty}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {filtered.map((story) => {
            const key = `${story.customerId}/${story.storyId}`;
            return (
              <li key={key}>
                <TriageStoryCard
                  story={overrideStory(story)}
                  onOpen={(s) => onFocus(s)}
                  onSend={handleSend}
                  sendDisabled={!aimerIntegrationConfigured}
                  aiAnalysis={aiSummaries[key] ?? null}
                  labels={labels.card}
                />
              </li>
            );
          })}
        </ul>
      )}
      {toast ? (
        <div
          role="status"
          data-testid={
            toast.kind === "success"
              ? "triage-story-send-toast-success"
              : "triage-story-send-toast-error"
          }
          className={
            toast.kind === "success"
              ? "fixed bottom-4 right-4 z-30 rounded-md border border-emerald-300/60 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 shadow-md dark:border-emerald-500/40 dark:bg-emerald-950/60 dark:text-emerald-200"
              : "fixed bottom-4 right-4 z-30 rounded-md border border-red-300/60 bg-red-50 px-3 py-2 text-sm text-red-900 shadow-md dark:border-red-500/40 dark:bg-red-950/60 dark:text-red-200"
          }
        >
          {toast.message}
        </div>
      ) : null}
      {focused ? (
        <TriageStoryDetail
          story={focused}
          period={period}
          loadDetail={loadDetail}
          aiAnalysis={
            aiSummaries[`${focused.customerId}/${focused.storyId}`] ?? null
          }
          onClose={() => onFocus(null)}
          onPivot={
            onPivotFromStory
              ? ({ dimension, value, member, members }) =>
                  onPivotFromStory({
                    story: focused,
                    members,
                    member,
                    dimension,
                    value,
                  })
              : undefined
          }
          labels={labels.detail}
          cardLabels={labels.card}
        />
      ) : null}
    </section>
  );
}

interface StoryDetailProps {
  story: TriageStory;
  period: TriagePeriod | undefined;
  loadDetail: StoryDetailLoader | undefined;
  /**
   * Resolved AI narrative analysis summary for the focused Story
   * (#645). `null` collapses the badge out of the detail header
   * (no badge for LOW / MEDIUM, missing report, or unconfigured
   * integration).
   */
  aiAnalysis: AiAnalysisStorySummary | null;
  onClose: () => void;
  /**
   * Pivot-from-Story (#553) callback. When defined the member table
   * renders a trailing actions column with per-row pivot dimension
   * buttons; clicking a button fires this with the chosen dimension,
   * value, and the full loaded member-detail list (so the consumer
   * can seed the pivot index over the Story's members rather than
   * fetch them again).
   */
  onPivot?: (args: {
    dimension: PivotDimensionId;
    value: PivotValue;
    /** The clicked Story member; threaded so the Phase 1 engagement-
     * signal capture can use that member's eventKey/kind/baselineVersion
     * as the row-bound reference (#588). */
    member: TriageStoryMemberDetail;
    members: readonly TriageStoryMemberDetail[];
  }) => void;
  labels: TriageStoryDetailLabels;
  /**
   * Card labels are reused for the title (auto-generated from
   * `primaryAsset` / duration / categories or the curated
   * `manualTitle`) and the member-count chip in the detail header so
   * the analyst keeps the same Story identity they clicked.
   */
  cardLabels: TriageStoryCardLabels;
}

const SCORE_FORMAT = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

interface DetailState {
  status: "idle" | "loading" | "ready" | "error";
  members: TriageStoryMemberDetail[];
  /**
   * Authoritative join count from the loader. `null` until the full
   * fetch resolves successfully — the dangling notice only renders
   * when this is non-null, so loading / error / unit-test (no loader)
   * states never label preview omissions as corpus-retention loss.
   */
  joinedCount: number | null;
  /**
   * Authoritative dangling signal from the loader. `null` until the
   * full fetch resolves; the notice only renders when this is `true`.
   */
  hasDanglingMembers: boolean | null;
}

const MEMBER_COUNT_FORMAT = new Intl.NumberFormat();

/**
 * Pivot dimensions surfaced on Story member rows (#553). Restricted
 * to dimensions whose extractor reads only fields actually present on
 * the Story member detail shape (`event_group_member ⨝
 * baseline_triaged_event` per #547) — the remaining dimensions live
 * under the Pivot panel's per-section rows where they apply
 * naturally to the full event corpus rather than to single rows.
 */
const STORY_MEMBER_ROW_PIVOT_DIMENSIONS: readonly PivotDimensionId[] = [
  "externalIp",
  "internalIp",
  "port",
  "host",
  "uriPattern",
  "dnsQuery",
  "sameSensor",
];

function TriageStoryDetail({
  story,
  period,
  loadDetail,
  aiAnalysis,
  onClose,
  onPivot,
  labels,
  cardLabels,
}: StoryDetailProps) {
  const stored = story.summary.memberCount;
  const title = renderStoryTitle(
    story.primaryAsset,
    story.summary,
    cardLabels.duration,
  );
  const ruleBadge =
    story.kind === "analyst_curated"
      ? cardLabels.ruleBadgeAnalyst
      : (story.ruleId ?? cardLabels.ruleBadgeAuto);
  const memberCountText = cardLabels.memberCountTemplate.replace(
    "{count}",
    MEMBER_COUNT_FORMAT.format(stored),
  );
  const [detail, setDetail] = useState<DetailState>({
    status: "idle",
    members: [],
    joinedCount: null,
    hasDanglingMembers: null,
  });

  // Fetch the full member table whenever the focused Story or
  // period rotates. Loader absence (unit-test path) leaves the panel
  // in `idle` with no dangling signal — the preview rows still
  // render but the notice stays hidden because we cannot prove
  // anything about retention loss from the top-3 preview alone.
  useEffect(() => {
    let cancelled = false;
    if (!loadDetail || !period) {
      setDetail({
        status: "idle",
        members: [],
        joinedCount: null,
        hasDanglingMembers: null,
      });
      return () => {
        cancelled = true;
      };
    }
    setDetail((prev) => ({ ...prev, status: "loading" }));
    loadDetail({
      customerId: story.customerId,
      storyId: story.storyId,
      storedMemberCount: stored,
    })
      .then((result) => {
        if (cancelled) return;
        if (result === null) {
          setDetail({
            status: "error",
            members: [],
            joinedCount: null,
            hasDanglingMembers: null,
          });
          return;
        }
        setDetail({
          status: "ready",
          members: result.members,
          joinedCount: result.members.length,
          hasDanglingMembers: result.hasDanglingMembers,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setDetail({
          status: "error",
          members: [],
          joinedCount: null,
          hasDanglingMembers: null,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [loadDetail, period, story.customerId, story.storyId, stored]);

  // Dangling notice renders ONLY against the authoritative join. The
  // loader's `hasDanglingMembers` flag is computed from the full
  // INNER JOIN (period-independent), so a Story whose preview is
  // smaller than its stored count for any reason — out-of-period
  // members, top-3 truncation, in-flight fetch — does not get
  // mislabeled as corpus-retention loss. The notice is suppressed
  // entirely while the panel is `idle` / `loading` / `error`.
  const showDangling =
    detail.status === "ready" &&
    detail.hasDanglingMembers === true &&
    detail.joinedCount !== null;
  const shown = detail.joinedCount ?? 0;
  const danglingDelta = showDangling ? Math.max(stored - shown, 0) : 0;

  // Choose the rendered row source — the full join when available,
  // the list-time top-3 preview otherwise. Both shapes feed the
  // shared {@link TriageEventTable} (#554) via a normalized
  // {@link TriageEventRow}; the full join carries source/destination
  // address so the optional columns surface when their labels are
  // provided.
  //
  // The `time` field is the raw ISO literal — the Story panel
  // continues to render `event_time_iso` verbatim per #547. The
  // asset surface formats with `formatDateTime` instead. Time
  // formatting stays on the caller side so this issue's extraction
  // does not change either surface's rendered output.
  const rows: ReadonlyArray<TriageEventRow> =
    detail.status === "ready"
      ? detail.members.map((m) => ({
          key: m.eventKey,
          time: m.eventTimeIso,
          kind: m.kind,
          category: m.category,
          baselineScore: m.baselineScore,
          origAddr: m.origAddr,
          respAddr: m.respAddr,
          // Marker slot is populated only when the member's
          // `protectedByStory` flag is set AND the surface supplied
          // the localized template; either side missing leaves the
          // leading cell unchanged.
          protectedByStory:
            m.protectedByStory && m.baselineScore !== null
              ? { score: m.baselineScore }
              : undefined,
        }))
      : story.topMembers.map((m) => ({
          key: m.eventKey,
          time: m.eventTimeIso,
          kind: m.kind,
          category: m.category,
          baselineScore: m.rawScore,
          origAddr: null,
          respAddr: null,
        }));
  // Marker renderer for the per-row leading cell. Only wired when the
  // labels carry the template — surfaces that have not yet adopted
  // the strictness slider in the Story view leave the marker absent.
  const protectedByStoryRenderer = labels.protectedByStoryMarker
    ? renderProtectedByStoryMarker(labels.protectedByStoryMarker)
    : undefined;
  const pivotActionsEnabled =
    onPivot !== undefined &&
    labels.pivotActionsColumn !== undefined &&
    labels.pivotActionTemplate !== undefined &&
    labels.pivotDimensions !== undefined &&
    detail.status === "ready";
  const tableLabels: TriageEventTableLabels = {
    timeColumn: labels.timeColumn,
    kindColumn: labels.kindColumn,
    categoryColumn: labels.categoryColumn,
    scoreColumn: labels.scoreColumn,
    origAddrColumn: labels.origAddrColumn,
    respAddrColumn: labels.respAddrColumn,
    actionsColumn: pivotActionsEnabled ? labels.pivotActionsColumn : undefined,
  };

  const memberByKey = useMemo(() => {
    const map = new Map<string, TriageStoryMemberDetail>();
    if (detail.status === "ready") {
      for (const m of detail.members) map.set(m.eventKey, m);
    }
    return map;
  }, [detail]);

  const handleRowPivot = (
    dimension: PivotDimensionId,
    value: PivotValue,
    member: TriageStoryMemberDetail,
  ) => {
    if (!onPivot || detail.status !== "ready") return;
    onPivot({ dimension, value, member, members: detail.members });
  };

  return (
    <section
      data-testid="triage-story-detail"
      data-story-id={`${story.customerId}/${story.storyId}`}
      aria-label={labels.heading}
      className="rounded-md border bg-card p-4 shadow-xs"
    >
      <header className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            {labels.heading}
          </p>
          <h3
            data-testid="triage-story-detail-title"
            className="text-base font-semibold text-foreground"
          >
            {title}
          </h3>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="rounded-sm border border-border bg-muted px-2 py-0.5 font-medium text-muted-foreground">
              {ruleBadge}
            </span>
            {renderAiAnalysisBadge(aiAnalysis, cardLabels.aiAnalysisBadge)}
            {story.score !== null ? (
              <span>
                <span className="font-medium">{labels.scoreLabel}:</span>{" "}
                <span className="font-mono">
                  {SCORE_FORMAT.format(story.score)}
                </span>
              </span>
            ) : null}
            <span data-testid="triage-story-detail-member-count">
              {memberCountText}
            </span>
            <span>
              <span className="font-medium">{labels.customerLabel}:</span>{" "}
              {story.customerName}
            </span>
          </p>
          <p
            data-testid="triage-story-detail-time-window"
            className="mt-1 font-mono text-xs text-muted-foreground"
          >
            {story.timeWindowStartIso} ~ {story.timeWindowEndIso}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-sm border border-border bg-background px-2 py-1 text-xs hover:bg-muted"
        >
          {labels.close}
        </button>
      </header>
      {showDangling && danglingDelta > 0 ? (
        <p
          data-testid="triage-story-dangling-notice"
          className="mb-2 text-xs text-muted-foreground"
        >
          {labels.danglingNoticeTemplate
            .replace("{shown}", String(shown))
            .replace("{stored}", String(stored))
            .replace("{aged}", String(danglingDelta))}
        </p>
      ) : null}
      {detail.status === "loading" ? (
        <p
          data-testid="triage-story-detail-loading"
          className="text-sm text-muted-foreground"
        >
          {labels.loading}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{labels.emptyMembers}</p>
      ) : (
        <TriageEventTable
          rows={rows}
          labels={tableLabels}
          renderProtectedByStoryMarker={protectedByStoryRenderer}
          renderRowActions={
            pivotActionsEnabled
              ? (row) => {
                  const member = memberByKey.get(row.key);
                  if (!member) return null;
                  return (
                    <StoryMemberPivotActions
                      member={member}
                      customerId={story.customerId}
                      onPivot={handleRowPivot}
                      template={labels.pivotActionTemplate as string}
                      dimensionLabels={
                        labels.pivotDimensions as Record<
                          PivotDimensionId,
                          string
                        >
                      }
                    />
                  );
                }
              : undefined
          }
        />
      )}
    </section>
  );
}

interface StoryMemberPivotActionsProps {
  member: TriageStoryMemberDetail;
  customerId: number;
  onPivot: (
    dimension: PivotDimensionId,
    value: PivotValue,
    member: TriageStoryMemberDetail,
  ) => void;
  template: string;
  dimensionLabels: Record<PivotDimensionId, string>;
}

function StoryMemberPivotActions({
  member,
  customerId,
  onPivot,
  template,
  dimensionLabels,
}: StoryMemberPivotActionsProps) {
  // Reuse the dimension registry's per-event extractor against an
  // adapted member event so the row surface only shows pivots whose
  // value actually exists on this row (e.g. a DNS member has no
  // `host`, an HTTP member has no `dnsQuery`). Keeping the extraction
  // logic in one place (the dimension registry) means a future
  // dimension addition does not need a parallel implementation here.
  const synthetic = useMemo(
    () => storyMemberToScoredEvent(member, customerId),
    [member, customerId],
  );
  const buttons = useMemo(() => {
    const out: Array<{
      dimension: PivotDimensionId;
      value: PivotValue;
    }> = [];
    const seen = new Set<string>();
    for (const id of STORY_MEMBER_ROW_PIVOT_DIMENSIONS) {
      const dim = getPivotDimension(id);
      for (const value of dim.extract(synthetic)) {
        const dedupeKey = `${id} ${value.key}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        out.push({ dimension: id, value });
      }
    }
    return out;
  }, [synthetic]);
  if (buttons.length === 0) return null;
  return (
    <div
      className="flex flex-wrap justify-end gap-1"
      data-testid="triage-story-member-pivot-actions"
    >
      {buttons.map(({ dimension, value }) => (
        <button
          key={`${dimension}:${value.key}`}
          type="button"
          data-testid="triage-story-member-pivot-action"
          data-dimension={dimension}
          data-value-key={value.key}
          onClick={() => onPivot(dimension, value, member)}
          aria-label={template
            .replace("{dimension}", dimensionLabels[dimension])
            .replace("{value}", value.label)}
          className="max-w-[20ch] truncate rounded border border-border/60 px-2 py-0.5 text-xs text-foreground hover:bg-accent"
        >
          {dimensionLabels[dimension]}: {value.label}
        </button>
      ))}
    </div>
  );
}
