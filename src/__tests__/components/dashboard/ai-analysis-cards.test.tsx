/**
 * Tests for the dashboard LIVE + DAILY report cards
 * (`src/components/dashboard/ai-analysis-cards.tsx`, #646).
 *
 * The component takes injectable `loadLive` / `loadDaily` fetcher seams
 * so the per-customer fan-out, the collapse rules ("only positive cards
 * render"; "all-negative customer produces no output"; "no positive
 * card anywhere collapses the section"), the timezone-derived DAILY
 * date, and the bounded-concurrency pump can all be exercised without
 * standing up the internal routes.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockUseTimezone = vi.hoisted(() => vi.fn(() => "UTC"));
vi.mock("@/components/providers/timezone-provider", () => ({
  useTimezone: mockUseTimezone,
}));

import {
  DASHBOARD_AI_ANALYSIS_MAX_IN_FLIGHT,
  DashboardAiAnalysisCards,
  type DashboardAiAnalysisCardsLabels,
} from "@/components/dashboard/ai-analysis-cards";
import type { AiAnalysisSummary } from "@/lib/aimer/analysis/summary-types";

const LABELS: DashboardAiAnalysisCardsLabels = {
  sectionHeading: "AI analyses",
  latestDigestTitle: "Latest digest",
  todayReportTitle: "Today's report",
  badge: {
    tierCritical: "Critical",
    tierHigh: "High",
    tooltipTemplate: "{tier} — severity {severity}, likelihood {likelihood}",
    linkAriaLabel: "Open {tier} AI analysis",
  },
};

function summary(
  overrides: Partial<AiAnalysisSummary> = {},
): AiAnalysisSummary {
  return {
    tier: "CRITICAL",
    href: "https://aimer.example.com/customers/acme/analysis/reports/LIVE/1970-01-01",
    severityScore: 0.9,
    likelihoodScore: 0.4,
    scoreKind: "aggregate",
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  mockUseTimezone.mockReturnValue("UTC");
});

describe("DashboardAiAnalysisCards", () => {
  it("renders a LIVE and a DAILY card for a customer with both positive", async () => {
    const loadLive = vi.fn().mockResolvedValue(summary({ tier: "CRITICAL" }));
    const loadDaily = vi.fn().mockResolvedValue(summary({ tier: "HIGH" }));

    render(
      <DashboardAiAnalysisCards
        customers={[{ id: 1, name: "Acme" }]}
        labels={LABELS}
        loadLive={loadLive}
        loadDaily={loadDaily}
      />,
    );

    expect(
      await screen.findByTestId("dashboard-ai-analysis-live-card"),
    ).toBeTruthy();
    expect(screen.getByTestId("dashboard-ai-analysis-daily-card")).toBeTruthy();
    expect(screen.getByText("Acme")).toBeTruthy();
  });

  it("renders only the LIVE card when DAILY resolves negative", async () => {
    const loadLive = vi.fn().mockResolvedValue(summary());
    const loadDaily = vi.fn().mockResolvedValue(null);

    render(
      <DashboardAiAnalysisCards
        customers={[{ id: 1, name: "Acme" }]}
        labels={LABELS}
        loadLive={loadLive}
        loadDaily={loadDaily}
      />,
    );

    expect(
      await screen.findByTestId("dashboard-ai-analysis-live-card"),
    ).toBeTruthy();
    await waitFor(() => expect(loadDaily).toHaveBeenCalled());
    expect(screen.queryByTestId("dashboard-ai-analysis-daily-card")).toBeNull();
  });

  it("produces no output for a customer whose LIVE and DAILY both resolve negative", async () => {
    const loadLive = vi.fn().mockResolvedValue(null);
    const loadDaily = vi.fn().mockResolvedValue(null);

    const { container } = render(
      <DashboardAiAnalysisCards
        customers={[{ id: 1, name: "Acme" }]}
        labels={LABELS}
        loadLive={loadLive}
        loadDaily={loadDaily}
      />,
    );

    await waitFor(() => {
      expect(loadLive).toHaveBeenCalled();
      expect(loadDaily).toHaveBeenCalled();
    });
    // The whole section collapses when no customer has a positive card.
    expect(screen.queryByTestId("dashboard-ai-analysis-section")).toBeNull();
    expect(screen.queryByText("Acme")).toBeNull();
    expect(container.querySelector("section")).toBeNull();
  });

  it("drops only the all-negative customer and keeps the positive one", async () => {
    const loadLive = vi.fn(async ({ customerId }: { customerId: number }) =>
      customerId === 1 ? summary() : null,
    );
    const loadDaily = vi.fn().mockResolvedValue(null);

    render(
      <DashboardAiAnalysisCards
        customers={[
          { id: 1, name: "Acme" },
          { id: 2, name: "Globex" },
        ]}
        labels={LABELS}
        loadLive={loadLive}
        loadDaily={loadDaily}
      />,
    );

    expect(await screen.findByText("Acme")).toBeTruthy();
    await waitFor(() => expect(loadLive).toHaveBeenCalledTimes(2));
    // Globex resolved both-negative → no per-customer block for it.
    expect(screen.queryByText("Globex")).toBeNull();
    const customerBlocks = screen.getAllByTestId(
      "dashboard-ai-analysis-customer",
    );
    expect(customerBlocks).toHaveLength(1);
  });

  it("fetches DAILY for the viewer's timezone calendar day, not UTC", async () => {
    // 2026-05-30T22:00:00Z is already 2026-05-31 in Seoul (UTC+9).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T22:00:00Z"));
    mockUseTimezone.mockReturnValue("Asia/Seoul");

    const loadLive = vi.fn().mockResolvedValue(null);
    const loadDaily = vi.fn().mockResolvedValue(null);

    try {
      render(
        <DashboardAiAnalysisCards
          customers={[{ id: 1, name: "Acme" }]}
          labels={LABELS}
          loadLive={loadLive}
          loadDaily={loadDaily}
        />,
      );
      await vi.waitFor(() => expect(loadDaily).toHaveBeenCalled());
    } finally {
      vi.useRealTimers();
    }

    expect(loadDaily).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 1, date: "2026-05-31" }),
    );
  });

  it("never exceeds the in-flight concurrency cap across the fan-out", async () => {
    const customers = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      name: `C${i + 1}`,
    }));

    let inFlight = 0;
    let peak = 0;
    const deferredResolvers: Array<() => void> = [];
    const gated = () =>
      new Promise<AiAnalysisSummary | null>((resolve) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        deferredResolvers.push(() => {
          inFlight -= 1;
          resolve(null);
        });
      });

    const loadLive = vi.fn(gated);
    const loadDaily = vi.fn(gated);

    render(
      <DashboardAiAnalysisCards
        customers={customers}
        labels={LABELS}
        loadLive={loadLive}
        loadDaily={loadDaily}
      />,
    );

    // 20 tasks (10 customers × 2 reads) queued; only the cap may start.
    await waitFor(() =>
      expect(deferredResolvers.length).toBe(
        DASHBOARD_AI_ANALYSIS_MAX_IN_FLIGHT,
      ),
    );
    expect(peak).toBeLessThanOrEqual(DASHBOARD_AI_ANALYSIS_MAX_IN_FLIGHT);

    // Drain the queue, releasing tasks one at a time; the pump refills
    // up to the cap but never beyond it.
    while (deferredResolvers.length > 0) {
      const release = deferredResolvers.shift();
      release?.();
      await Promise.resolve();
      await Promise.resolve();
    }

    await waitFor(() => {
      expect(loadLive).toHaveBeenCalledTimes(10);
      expect(loadDaily).toHaveBeenCalledTimes(10);
    });
    expect(peak).toBeLessThanOrEqual(DASHBOARD_AI_ANALYSIS_MAX_IN_FLIGHT);
  });

  it("renders the badge with the summary's tier and links to its href", async () => {
    const loadLive = vi.fn().mockResolvedValue(
      summary({
        tier: "CRITICAL",
        href: "https://aimer.example.com/customers/acme/analysis/reports/LIVE/1970-01-01",
      }),
    );
    const loadDaily = vi.fn().mockResolvedValue(null);

    render(
      <DashboardAiAnalysisCards
        customers={[{ id: 1, name: "Acme" }]}
        labels={LABELS}
        loadLive={loadLive}
        loadDaily={loadDaily}
      />,
    );

    const card = await screen.findByTestId("dashboard-ai-analysis-live-card");
    const link = card.querySelector("a");
    expect(link?.getAttribute("href")).toBe(
      "https://aimer.example.com/customers/acme/analysis/reports/LIVE/1970-01-01",
    );
    expect(link?.getAttribute("data-tier")).toBe("CRITICAL");
    expect(link?.getAttribute("target")).toBe("_blank");
  });
});
