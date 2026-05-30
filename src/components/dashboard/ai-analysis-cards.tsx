"use client";

/**
 * Dashboard LIVE + DAILY report cards (RFC 0002 Phase 2,
 * aicers/aice-web-next#646).
 *
 * Renders, per in-scope customer, a "Latest digest" (LIVE) card and a
 * "Today's report" (DAILY) card. Each card is the reused
 * {@link AiAnalysisBadge} (tier + scores in the tooltip) plus the
 * card's own static title — nothing is parsed out of analysis text. The
 * shared {@link AiAnalysisSummary} shape carries no text field, so the
 * card never surfaces a headline or highlight.
 *
 * Per-customer scoping is explicit: the dashboard resolves an effective
 * scope that can span many customers (all customers for admins), and
 * this component fetches one LIVE and one DAILY summary per customer
 * through the single-customer internal routes. Reads go through a
 * bounded-concurrency queue (the same fan-out shape the Stories surface
 * uses) so an admin's all-customer dashboard cannot fan out into one
 * simultaneous request per customer.
 *
 * Collapse rules (#646 "All-negative customers collapse out"):
 * - Only cards backed by a positive (`200`) summary render. A `204` /
 *   non-200 (including a `403` for a `dashboard:read`-only viewer
 *   without `triage:read`) maps to `null` → no card, with no skeleton
 *   or placeholder.
 * - A customer whose LIVE *and* DAILY both resolve negative produces no
 *   output at all — no per-customer header or section.
 * - When no customer has any positive card, the whole section collapses
 *   out.
 *
 * DAILY date handling: the `{date}` is the viewer's current calendar
 * day derived from {@link useTimezone}, so a tab whose timezone
 * resolves to a different day fetches that day's report, not the
 * server's. The date also rolls over at the viewer's next local
 * midnight while the dashboard stays open — the component drops the
 * previous day's DAILY summaries and re-fetches the new day's, so a
 * long-lived tab never keeps showing yesterday's report as "Today's".
 *
 * Negative-retry window (#646 "Negative-cache TTL configurable per
 * surface"): a card is not a one-shot. When a surface resolves negative
 * (`null` from a 204 / non-200 / transient fetch failure / a
 * still-settling upstream), the component schedules a re-fetch for that
 * one customer/surface after the surface's TTL, and keeps doing so until
 * it resolves positive — so a report that becomes available *after* the
 * dashboard opened (e.g. a DAILY report that lands mid-day, or a LIVE
 * digest that crosses threshold) eventually surfaces without a reload.
 * LIVE polls on a minute cadence and DAILY on a much longer cadence,
 * matching their upstream production rates; both windows are
 * configurable per surface. A positive result stops the retry loop for
 * that card — positives are not re-polled, mirroring the Stories
 * surface's negative-only TTL.
 */

import { useEffect, useState } from "react";

import { useTimezone } from "@/components/providers/timezone-provider";
import {
  type AiAnalysisBadgeLabels,
  renderAiAnalysisBadge,
} from "@/components/triage/story/ai-analysis-badge";
import {
  msUntilNextDayInTimezone,
  todayInTimezone,
} from "@/lib/aimer/analysis/report-date";
import {
  type AiAnalysisDailySummaryFetcher,
  type AiAnalysisLiveSummaryFetcher,
  fetchAiAnalysisDailySummary,
  fetchAiAnalysisLiveSummary,
} from "@/lib/aimer/analysis/report-summary.client";
import type { AiAnalysisSummary } from "@/lib/aimer/analysis/summary-types";

/**
 * Maximum in-flight report-summary requests across the whole dashboard
 * fan-out. An admin dashboard can span many customers (2 reads each),
 * so the queue caps concurrency the same way the Stories surface does.
 */
export const DASHBOARD_AI_ANALYSIS_MAX_IN_FLIGHT = 6;

/**
 * Default negative-retry window for the LIVE card: 1 minute. LIVE is a
 * rolling, minute-cadence digest, so a card that is currently negative
 * is re-checked about once a minute until it resolves positive.
 */
export const LIVE_NEGATIVE_TTL_MS = 60 * 1000;

/**
 * Default negative-retry window for the DAILY card: 30 minutes. The
 * DAILY report is produced once per calendar day but may land any time
 * during that day, so a negative card is re-checked on a coarse cadence
 * — often enough to surface the report once it is published, without the
 * minute-rate churn LIVE needs.
 */
export const DAILY_NEGATIVE_TTL_MS = 30 * 60 * 1000;

export interface DashboardCustomer {
  id: number;
  name: string;
}

export interface DashboardAiAnalysisCardsLabels {
  /** Section heading rendered above the per-customer card blocks. */
  sectionHeading: string;
  /** Static title for the LIVE card. */
  latestDigestTitle: string;
  /** Static title for the DAILY card. */
  todayReportTitle: string;
  /** Badge copy (shared with the Stories surface). */
  badge: AiAnalysisBadgeLabels;
}

interface DashboardAiAnalysisCardsProps {
  customers: ReadonlyArray<DashboardCustomer>;
  labels: DashboardAiAnalysisCardsLabels;
  /**
   * Fetcher seams — defaulted to the real report clients but injectable
   * so the component is unit-testable without standing up the internal
   * routes.
   */
  loadLive?: AiAnalysisLiveSummaryFetcher;
  loadDaily?: AiAnalysisDailySummaryFetcher;
  /**
   * Negative-retry windows in ms. A card that resolves negative is
   * re-fetched after its surface's window and keeps retrying until it
   * resolves positive. Defaulted to {@link LIVE_NEGATIVE_TTL_MS} /
   * {@link DAILY_NEGATIVE_TTL_MS}; pass `0` to disable retries (used by
   * tests that assert the one-shot path). Injectable so tests can drive
   * the retry loop with a short window.
   */
  liveNegativeTtlMs?: number;
  dailyNegativeTtlMs?: number;
}

/**
 * One customer's resolved report summaries. `undefined` = still in
 * flight (renders nothing); `null` = resolved negative (no card); a
 * summary = positive hit.
 */
interface CustomerReports {
  live?: AiAnalysisSummary | null;
  daily?: AiAnalysisSummary | null;
}

export function DashboardAiAnalysisCards({
  customers,
  labels,
  loadLive = fetchAiAnalysisLiveSummary,
  loadDaily = fetchAiAnalysisDailySummary,
  liveNegativeTtlMs = LIVE_NEGATIVE_TTL_MS,
  dailyNegativeTtlMs = DAILY_NEGATIVE_TTL_MS,
}: DashboardAiAnalysisCardsProps) {
  const timezone = useTimezone();
  const [reports, setReports] = useState<Record<number, CustomerReports>>({});

  // One effect owns the whole read lifecycle — the initial LIVE+DAILY
  // fan-out, the per-surface negative-retry loops, and the DAILY date
  // rollover at the viewer's local midnight. Keeping it in a single
  // effect (rather than splitting the rollover out and re-keying the
  // fetch on `dailyDate`) is what lets the rollover re-fetch *only* DAILY:
  // a `dailyDate`-keyed effect would tear down and rebuild every task,
  // re-polling LIVE and letting a transient post-midnight LIVE `null`
  // overwrite an already-positive "Latest digest" card. Here the LIVE
  // tasks are enqueued once and only ever re-run via their own
  // negative-retry loop; the midnight rollover touches DAILY alone.
  useEffect(() => {
    let cancelled = false;

    // The viewer's current local calendar day. A local variable (not
    // React state) because nothing renders the date directly — only the
    // DAILY summaries it produces — and keeping it out of the dep list is
    // what stops the rollover from re-running the LIVE fan-out.
    let dailyDate = todayInTimezone(timezone);
    // Bumped on every rollover so that DAILY tasks (and their scheduled
    // retries) belonging to a previous day no-op instead of writing a
    // stale date's result or running a second retry loop alongside the
    // new day's.
    let dailyEpoch = 0;

    // A growable work queue (initial fan-out plus retries that fire
    // later) drained by a bounded-concurrency pump, and the set of
    // pending retry timers so they can be cleared on cleanup.
    const queue: Array<() => Promise<void>> = [];
    const retryTimers = new Set<ReturnType<typeof setTimeout>>();
    let rolloverTimer: ReturnType<typeof setTimeout> | undefined;
    let active = 0;

    const pump = () => {
      while (
        !cancelled &&
        active < DASHBOARD_AI_ANALYSIS_MAX_IN_FLIGHT &&
        queue.length > 0
      ) {
        const task = queue.shift();
        if (!task) break;
        active += 1;
        task()
          // The report clients already normalize errors to null; a throw
          // here would only be a synchronous bug in an injected fetcher.
          .catch(() => {})
          .finally(() => {
            active -= 1;
            pump();
          });
      }
    };

    // Re-enqueue `task` after `ttlMs`. A non-positive TTL disables the
    // retry (one-shot), so a card stays as last resolved.
    const scheduleRetry = (ttlMs: number, task: () => Promise<void>) => {
      if (cancelled || ttlMs <= 0) return;
      const timer = setTimeout(() => {
        retryTimers.delete(timer);
        if (cancelled) return;
        queue.push(task);
        pump();
      }, ttlMs);
      retryTimers.add(timer);
    };

    // LIVE: one self-rescheduling task per customer. Enqueued once and
    // re-run only by its own negative-retry loop — never re-fetched by the
    // DAILY rollover, so an already-positive "Latest digest" card cannot
    // flash back to nothing when the day turns over.
    const enqueueLive = (customerId: number) => {
      const liveTask = async () => {
        const summary = await loadLive({ customerId });
        if (cancelled) return;
        setReports((prev) => ({
          ...prev,
          [customerId]: { ...prev[customerId], live: summary },
        }));
        if (summary === null) scheduleRetry(liveNegativeTtlMs, liveTask);
      };
      queue.push(liveTask);
    };

    // DAILY: one self-rescheduling task per customer, tagged with the date
    // epoch it was created in. If a rollover bumps the epoch while the
    // task is in flight or waiting on a retry, the task no-ops — the new
    // day's task is the only one that writes state or keeps retrying.
    const enqueueDaily = (customerId: number) => {
      const epoch = dailyEpoch;
      const date = dailyDate;
      const dailyTask = async () => {
        if (cancelled || epoch !== dailyEpoch) return;
        const summary = await loadDaily({ customerId, date });
        if (cancelled || epoch !== dailyEpoch) return;
        setReports((prev) => ({
          ...prev,
          [customerId]: { ...prev[customerId], daily: summary },
        }));
        if (summary === null) scheduleRetry(dailyNegativeTtlMs, dailyTask);
      };
      queue.push(dailyTask);
    };

    for (const customer of customers) {
      enqueueLive(customer.id);
      enqueueDaily(customer.id);
    }
    pump();

    // Roll the DAILY date over at the viewer's next local midnight. The
    // wake-up instant is exact (DST-aware), but we still recompute the day
    // on fire and only advance when it has actually changed, so an early
    // wake-up is a harmless no-op. On a real change we drop the previous
    // day's DAILY summaries (so a stale "Today's report" card stops
    // showing under that title until the new day resolves), bump the epoch
    // to retire the old day's tasks, and re-fan-out DAILY only.
    const rollover = () => {
      if (cancelled) return;
      const today = todayInTimezone(timezone);
      if (today !== dailyDate) {
        dailyDate = today;
        dailyEpoch += 1;
        setReports((prev) => {
          const next: Record<number, CustomerReports> = {};
          for (const [id, customerReports] of Object.entries(prev)) {
            next[Number(id)] = { ...customerReports, daily: undefined };
          }
          return next;
        });
        for (const customer of customers) enqueueDaily(customer.id);
        pump();
      }
      scheduleRollover();
    };

    const scheduleRollover = () => {
      if (cancelled) return;
      // 1 s past midnight so a wake-up that fires a hair early still lands
      // on the new calendar day rather than re-reading the old one.
      const delay = msUntilNextDayInTimezone(timezone) + 1000;
      rolloverTimer = setTimeout(rollover, delay);
    };
    scheduleRollover();

    return () => {
      cancelled = true;
      for (const timer of retryTimers) clearTimeout(timer);
      retryTimers.clear();
      if (rolloverTimer) clearTimeout(rolloverTimer);
    };
  }, [
    customers,
    timezone,
    loadLive,
    loadDaily,
    liveNegativeTtlMs,
    dailyNegativeTtlMs,
  ]);

  // Keep only customers with at least one positive card, preserving the
  // scope order. A customer whose LIVE and DAILY both resolved negative
  // (or are still loading) contributes nothing.
  const visible = customers.filter((customer) => {
    const r = reports[customer.id];
    return Boolean(r?.live) || Boolean(r?.daily);
  });

  if (visible.length === 0) return null;

  return (
    <section
      aria-label={labels.sectionHeading}
      data-testid="dashboard-ai-analysis-section"
      className="flex flex-col gap-3"
    >
      <h2 className="text-base font-semibold text-foreground">
        {labels.sectionHeading}
      </h2>
      <div className="flex flex-col gap-4">
        {visible.map((customer) => {
          const r = reports[customer.id];
          return (
            <div
              key={customer.id}
              data-testid="dashboard-ai-analysis-customer"
              data-customer-id={customer.id}
              className="flex flex-col gap-2"
            >
              <h3 className="text-sm font-medium text-muted-foreground">
                {customer.name}
              </h3>
              <div className="grid gap-3 sm:grid-cols-2">
                {r?.live ? (
                  <ReportCard
                    title={labels.latestDigestTitle}
                    summary={r.live}
                    badgeLabels={labels.badge}
                    testId="dashboard-ai-analysis-live-card"
                  />
                ) : null}
                {r?.daily ? (
                  <ReportCard
                    title={labels.todayReportTitle}
                    summary={r.daily}
                    badgeLabels={labels.badge}
                    testId="dashboard-ai-analysis-daily-card"
                  />
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

interface ReportCardProps {
  title: string;
  summary: AiAnalysisSummary;
  badgeLabels: AiAnalysisBadgeLabels;
  testId: string;
}

function ReportCard({ title, summary, badgeLabels, testId }: ReportCardProps) {
  return (
    <div
      data-testid={testId}
      className="flex items-center justify-between gap-3 rounded-md border bg-card p-4 shadow-xs"
    >
      <span className="text-sm font-medium text-foreground">{title}</span>
      {renderAiAnalysisBadge(summary, badgeLabels)}
    </div>
  );
}
