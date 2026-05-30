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

import { act, render, screen, waitFor } from "@testing-library/react";
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

  it("rolls the DAILY date over at the viewer's local midnight, dropping the stale report and re-fetching the new day", async () => {
    // Open the dashboard at 23:30 UTC, just before local midnight.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T23:30:00Z"));
    mockUseTimezone.mockReturnValue("UTC");

    let releaseNewDaily: ((value: AiAnalysisSummary | null) => void) | null =
      null;
    // LIVE stays positive throughout; DAILY is positive for 2026-05-30 but
    // its 2026-05-31 fetch is held open so we can observe the stale-card
    // gap before the new day resolves.
    const loadLive = vi.fn().mockResolvedValue(summary({ tier: "CRITICAL" }));
    const loadDaily = vi.fn(({ date }: { date: string }) =>
      date === "2026-05-30"
        ? Promise.resolve(summary({ tier: "HIGH" }))
        : new Promise<AiAnalysisSummary | null>((resolve) => {
            releaseNewDaily = resolve;
          }),
    );

    try {
      render(
        <DashboardAiAnalysisCards
          customers={[{ id: 1, name: "Acme" }]}
          labels={LABELS}
          loadLive={loadLive}
          loadDaily={loadDaily}
          liveNegativeTtlMs={0}
          dailyNegativeTtlMs={0}
        />,
      );

      // Day 1: the DAILY card renders for 2026-05-30.
      await vi.waitFor(() =>
        expect(
          screen.queryByTestId("dashboard-ai-analysis-daily-card"),
        ).toBeTruthy(),
      );
      expect(loadDaily).toHaveBeenLastCalledWith(
        expect.objectContaining({ customerId: 1, date: "2026-05-30" }),
      );

      // Cross local midnight (→ 2026-05-31T00:01Z).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
      });

      // The new calendar day is fetched, and the stale "Today's report"
      // card is dropped while that fetch is still pending.
      await vi.waitFor(() =>
        expect(loadDaily).toHaveBeenLastCalledWith(
          expect.objectContaining({ customerId: 1, date: "2026-05-31" }),
        ),
      );
      expect(
        screen.queryByTestId("dashboard-ai-analysis-daily-card"),
      ).toBeNull();
      // The LIVE card is unaffected by the DAILY rollover.
      expect(
        screen.queryByTestId("dashboard-ai-analysis-live-card"),
      ).toBeTruthy();

      // Once the new day resolves positive, the card returns for it.
      await act(async () => {
        releaseNewDaily?.(summary({ tier: "HIGH" }));
      });
      await vi.waitFor(() =>
        expect(
          screen.queryByTestId("dashboard-ai-analysis-daily-card"),
        ).toBeTruthy(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves an already-positive LIVE card untouched when the DAILY date rolls over", async () => {
    // Regression for Round 5: the DAILY midnight rollover must not
    // re-fetch LIVE. `loadLive` resolves positive on its first (and only)
    // call but would resolve `null` if called again — if the rollover
    // re-polled LIVE, that transient `null` would hide an already-positive
    // "Latest digest" card. LIVE must be fetched exactly once.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T23:30:00Z"));
    mockUseTimezone.mockReturnValue("UTC");

    const loadLive = vi
      .fn()
      .mockResolvedValueOnce(summary({ tier: "CRITICAL" }))
      .mockResolvedValue(null);
    const loadDaily = vi.fn(({ date }: { date: string }) =>
      Promise.resolve(date === "2026-05-30" ? summary({ tier: "HIGH" }) : null),
    );

    try {
      render(
        <DashboardAiAnalysisCards
          customers={[{ id: 1, name: "Acme" }]}
          labels={LABELS}
          loadLive={loadLive}
          loadDaily={loadDaily}
          liveNegativeTtlMs={0}
          dailyNegativeTtlMs={0}
        />,
      );

      // The LIVE card renders positive before midnight.
      await vi.waitFor(() =>
        expect(
          screen.queryByTestId("dashboard-ai-analysis-live-card"),
        ).toBeTruthy(),
      );

      // Cross local midnight, triggering the DAILY rollover.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
      });

      // The new day's DAILY was fetched (proving the rollover ran)...
      await vi.waitFor(() =>
        expect(loadDaily).toHaveBeenLastCalledWith(
          expect.objectContaining({ customerId: 1, date: "2026-05-31" }),
        ),
      );
      // ...but LIVE was never re-fetched, so its positive card survives.
      expect(loadLive).toHaveBeenCalledTimes(1);
      expect(
        screen.queryByTestId("dashboard-ai-analysis-live-card"),
      ).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-fetches DAILY only (not LIVE) when the timezone provider settles to a new day", async () => {
    // Regression for Round 6: `TimezoneProvider` starts with the browser
    // zone and then settles to the saved preference. When that settle
    // moves the effective calendar day, the dashboard must re-fan-out
    // DAILY for the new date — clearing the stale day's card while the new
    // fetch is pending — but must NOT re-poll LIVE, which has no date
    // dependency. Here `loadLive` resolves positive on its first (and only
    // expected) call but would resolve `null` if called again; a re-poll
    // would flash the already-positive "Latest digest" back to nothing.
    //
    // 2026-05-30T22:00:00Z is still 2026-05-30 in UTC but already
    // 2026-05-31 in Asia/Seoul (UTC+9), so the settle moves the day.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T22:00:00Z"));
    mockUseTimezone.mockReturnValue("UTC");

    let releaseSeoulDaily: ((value: AiAnalysisSummary | null) => void) | null =
      null;
    const loadLive = vi
      .fn()
      .mockResolvedValueOnce(summary({ tier: "CRITICAL" }))
      .mockResolvedValue(null);
    const loadDaily = vi.fn(({ date }: { date: string }) =>
      date === "2026-05-30"
        ? Promise.resolve(summary({ tier: "HIGH" }))
        : new Promise<AiAnalysisSummary | null>((resolve) => {
            releaseSeoulDaily = resolve;
          }),
    );

    // Stable reference: a context-driven timezone settle re-renders the
    // component with the same `customers` prop, so only the timezone effect
    // reacts — the main read-lifecycle effect (keyed on `customers`) must
    // not tear down and re-poll LIVE.
    const customers = [{ id: 1, name: "Acme" }];

    try {
      const { rerender } = render(
        <DashboardAiAnalysisCards
          customers={customers}
          labels={LABELS}
          loadLive={loadLive}
          loadDaily={loadDaily}
          liveNegativeTtlMs={0}
          dailyNegativeTtlMs={0}
        />,
      );

      // Browser-zone (UTC) load: both cards render for 2026-05-30.
      await vi.waitFor(() => {
        expect(
          screen.queryByTestId("dashboard-ai-analysis-live-card"),
        ).toBeTruthy();
        expect(
          screen.queryByTestId("dashboard-ai-analysis-daily-card"),
        ).toBeTruthy();
      });
      expect(loadDaily).toHaveBeenLastCalledWith(
        expect.objectContaining({ customerId: 1, date: "2026-05-30" }),
      );

      // The provider settles to the saved preference (Asia/Seoul), which
      // is already the next calendar day.
      mockUseTimezone.mockReturnValue("Asia/Seoul");
      await act(async () => {
        rerender(
          <DashboardAiAnalysisCards
            customers={customers}
            labels={LABELS}
            loadLive={loadLive}
            loadDaily={loadDaily}
            liveNegativeTtlMs={0}
            dailyNegativeTtlMs={0}
          />,
        );
      });

      // DAILY re-fetches for the new (Seoul) day, and the stale card is
      // dropped while that fetch is still pending.
      await vi.waitFor(() =>
        expect(loadDaily).toHaveBeenLastCalledWith(
          expect.objectContaining({ customerId: 1, date: "2026-05-31" }),
        ),
      );
      expect(
        screen.queryByTestId("dashboard-ai-analysis-daily-card"),
      ).toBeNull();
      // LIVE was never re-fetched, so its positive card survives the
      // settle untouched.
      expect(loadLive).toHaveBeenCalledTimes(1);
      expect(
        screen.queryByTestId("dashboard-ai-analysis-live-card"),
      ).toBeTruthy();

      // The new day's DAILY resolves positive and the card returns for it.
      await act(async () => {
        releaseSeoulDaily?.(summary({ tier: "HIGH" }));
      });
      await vi.waitFor(() =>
        expect(
          screen.queryByTestId("dashboard-ai-analysis-daily-card"),
        ).toBeTruthy(),
      );
    } finally {
      vi.useRealTimers();
    }
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

  it("retries a negative card after the surface TTL and surfaces it once it turns positive", async () => {
    // A LIVE report that is missing on first load but lands shortly
    // after. The one-shot pre-#646-review behavior would leave the card
    // hidden forever; the negative-retry window must re-fetch it.
    const loadLive = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(summary({ tier: "HIGH" }));
    const loadDaily = vi.fn().mockResolvedValue(null);

    render(
      <DashboardAiAnalysisCards
        customers={[{ id: 1, name: "Acme" }]}
        labels={LABELS}
        loadLive={loadLive}
        loadDaily={loadDaily}
        liveNegativeTtlMs={10}
        dailyNegativeTtlMs={0}
      />,
    );

    // First resolution is negative: no card yet.
    await waitFor(() => expect(loadLive).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("dashboard-ai-analysis-live-card")).toBeNull();

    // After the negative TTL the card re-fetches and now resolves
    // positive, so it surfaces without a reload.
    expect(
      await screen.findByTestId("dashboard-ai-analysis-live-card"),
    ).toBeTruthy();
    expect(loadLive.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("stops retrying once a card resolves positive", async () => {
    const loadLive = vi.fn().mockResolvedValue(summary());
    const loadDaily = vi.fn().mockResolvedValue(null);

    render(
      <DashboardAiAnalysisCards
        customers={[{ id: 1, name: "Acme" }]}
        labels={LABELS}
        loadLive={loadLive}
        loadDaily={loadDaily}
        liveNegativeTtlMs={10}
        dailyNegativeTtlMs={0}
      />,
    );

    await screen.findByTestId("dashboard-ai-analysis-live-card");
    // A positive result is never re-polled: give the (disabled) retry
    // window several multiples of time and confirm no further fetch.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(loadLive).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the negative TTL is 0 (one-shot opt-out)", async () => {
    const loadLive = vi.fn().mockResolvedValue(null);
    const loadDaily = vi.fn().mockResolvedValue(null);

    render(
      <DashboardAiAnalysisCards
        customers={[{ id: 1, name: "Acme" }]}
        labels={LABELS}
        loadLive={loadLive}
        loadDaily={loadDaily}
        liveNegativeTtlMs={0}
        dailyNegativeTtlMs={0}
      />,
    );

    await waitFor(() => expect(loadLive).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(loadLive).toHaveBeenCalledTimes(1);
    expect(loadDaily).toHaveBeenCalledTimes(1);
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
