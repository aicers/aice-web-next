"use client";

/**
 * Stories list + detail container (#490).
 *
 * Renders a server-supplied list of {@link TriageStory} rows as cards,
 * with an optional focused-Story detail panel beneath. The detail
 * panel reuses the member-table layout from the asset-detail
 * component family — but Stories never share `TriageAsset` shape, so
 * the table is owned here.
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
  type TriageEventRow,
  TriageEventTable,
  type TriageEventTableLabels,
} from "../event-row/triage-event-table";
import { TriageStoryCard, type TriageStoryCardLabels } from "./story-card";
import { renderStoryTitle } from "./story-title";

export type { StoriesSortOrder };

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
}

interface TriageStoriesViewProps {
  stories: ReadonlyArray<TriageStory>;
  truncated: boolean;
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
  onPivotFromStory?: (args: {
    story: TriageStory;
    members: readonly TriageStoryMemberDetail[];
    dimension: PivotDimensionId;
    value: PivotValue;
  }) => void;
  labels: TriageStoriesViewLabels;
}

export function TriageStoriesView({
  stories,
  truncated,
  focused,
  onFocus,
  showStaleHashWarning,
  period,
  loadDetail,
  refreshStories,
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
          {filtered.map((story) => (
            <li key={`${story.customerId}/${story.storyId}`}>
              <TriageStoryCard
                story={story}
                onOpen={(s) => onFocus(s)}
                labels={labels.card}
              />
            </li>
          ))}
        </ul>
      )}
      {focused ? (
        <TriageStoryDetail
          story={focused}
          period={period}
          loadDetail={loadDetail}
          onClose={() => onFocus(null)}
          onPivot={
            onPivotFromStory
              ? ({ dimension, value, members }) =>
                  onPivotFromStory({
                    story: focused,
                    members,
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

  const handleRowPivot = (dimension: PivotDimensionId, value: PivotValue) => {
    if (!onPivot || detail.status !== "ready") return;
    onPivot({ dimension, value, members: detail.members });
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
  onPivot: (dimension: PivotDimensionId, value: PivotValue) => void;
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
          onClick={() => onPivot(dimension, value)}
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
