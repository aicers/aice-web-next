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
 * server's.
 */

import { useEffect, useMemo, useState } from "react";

import { useTimezone } from "@/components/providers/timezone-provider";
import {
  type AiAnalysisBadgeLabels,
  renderAiAnalysisBadge,
} from "@/components/triage/story/ai-analysis-badge";
import { todayInTimezone } from "@/lib/aimer/analysis/report-date";
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
}: DashboardAiAnalysisCardsProps) {
  const timezone = useTimezone();
  // The viewer's current calendar day in their timezone. Recomputed
  // when the timezone provider settles the persisted preference, which
  // re-runs the fetch effect below so a viewer past midnight in their
  // own zone fetches that day's report.
  const dailyDate = useMemo(() => todayInTimezone(timezone), [timezone]);

  const [reports, setReports] = useState<Record<number, CustomerReports>>({});

  useEffect(() => {
    let cancelled = false;

    // Build the flat task list: one LIVE + one DAILY read per customer.
    const tasks: Array<() => Promise<void>> = [];
    for (const customer of customers) {
      const customerId = customer.id;
      tasks.push(async () => {
        const summary = await loadLive({ customerId });
        if (cancelled) return;
        setReports((prev) => ({
          ...prev,
          [customerId]: { ...prev[customerId], live: summary },
        }));
      });
      tasks.push(async () => {
        const summary = await loadDaily({ customerId, date: dailyDate });
        if (cancelled) return;
        setReports((prev) => ({
          ...prev,
          [customerId]: { ...prev[customerId], daily: summary },
        }));
      });
    }

    // Bounded-concurrency pump: keep up to MAX_IN_FLIGHT tasks running,
    // draining the queue as each settles.
    let next = 0;
    let active = 0;
    const pump = () => {
      while (
        !cancelled &&
        active < DASHBOARD_AI_ANALYSIS_MAX_IN_FLIGHT &&
        next < tasks.length
      ) {
        const task = tasks[next++];
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
    pump();

    return () => {
      cancelled = true;
    };
  }, [customers, dailyDate, loadLive, loadDaily]);

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
