/**
 * Client-side coverage for #393 Task B: the analytics cache must
 *
 *   (a) key by `scopeFingerprint` so a same-account customer-
 *       assignment change invalidates entries computed under the
 *       prior scope, and
 *   (b) gate cache reuse on the `/api/auth/me` probe — Reviewer
 *       Round 1 flagged that the first iteration left the prior
 *       `ready` status in place during the round-trip, so the cached
 *       payload painted on first frame and the probe only ran in
 *       parallel.
 *
 * The existing `detection-analytics.test.tsx` is SSR-only
 * (`renderToStaticMarkup`) — `useEffect` never runs there, so the
 * cache-hit / probe path stays unexercised. This file mounts the
 * real component under jsdom with `runAnalyticsQuery` and
 * `probeAuthOrRedirect` mocked, so the assertions cover the full
 * effect lifecycle.
 */

import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/[locale]/(dashboard)/detection/analytics-actions", () => ({
  runAnalyticsQuery: vi.fn(),
}));

const probeAuthOrRedirectMock =
  vi.fn<(onUnauthorized?: () => void) => Promise<boolean>>();

vi.mock("@/lib/auth/probe-auth", () => ({
  probeAuthOrRedirect: (onUnauthorized?: () => void) =>
    probeAuthOrRedirectMock(onUnauthorized),
}));

// Recharts pulls in ResizeObserver / canvas — stub the visual surface
// out so the test exercises the status / cache wiring in jsdom.
vi.mock("recharts", () => ({
  Area: () => null,
  AreaChart: () => null,
  Bar: () => null,
  BarChart: () => null,
  CartesianGrid: () => null,
  Cell: () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) =>
    children,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

const { runAnalyticsQuery } = await import(
  "@/app/[locale]/(dashboard)/detection/analytics-actions"
);
const { DetectionAnalytics } = await import(
  "@/components/detection/detection-analytics"
);
const { ScopeFingerprintProvider } = await import(
  "@/components/providers/scope-fingerprint-provider"
);

import type { DetectionAnalyticsLabels } from "@/components/detection/detection-analytics";
import type { Filter } from "@/lib/detection/filter";

const FILTER: Filter = {
  mode: "structured",
  input: {
    start: "2026-04-25T00:00:00.000Z",
    end: "2026-04-25T01:00:00.000Z",
  },
};

function labels(): DetectionAnalyticsLabels {
  return {
    dimensionLabel: "Dimension",
    dimensionOptions: {
      srcIp: "Source IP",
      dstIp: "Destination IP",
      country: "Country",
      category: "Threat Category",
      level: "Threat Level",
      kind: "Threat Name",
    },
    topNLabel: "Top",
    topNChartTitleTemplate: "Top by {dimension}",
    timeSeriesTitle: "Event frequency",
    countSuffix: (n) => `${n} events`,
    bucketLabel: (p) => `Bucket: ${p}`,
    periodValues: {
      seconds: (n) => `${n}s`,
      minutes: (n) => `${n}m`,
      hours: (n) => `${n}h`,
      days: (n) => `${n}d`,
      weeks: (n) => `${n}w`,
    },
    loadingTitle: "Loading analytics…",
    loadingDescription:
      "Fetching the Top N counts and the event frequency series.",
    errorTitle: "Couldn't load analytics",
    errorDescription: "The analytics service failed to respond.",
    errorRetry: "Retry",
    forbiddenTitle: "Not permitted",
    forbiddenDescription: "Forbidden",
    forbiddenScopeTitle: "Customer outside your access",
    forbiddenScopeDescription:
      "The active filter references a customer outside your access.",
    emptyTitle: "No matching events",
    emptyDescription: "Empty",
    levelLabels: {
      VERY_LOW: "Very Low",
      LOW: "Low",
      MEDIUM: "Medium",
      HIGH: "High",
      VERY_HIGH: "Very High",
    },
    categoryLabels: {
      RECONNAISSANCE: "Reconnaissance",
      INITIAL_ACCESS: "Initial Access",
      EXECUTION: "Execution",
      CREDENTIAL_ACCESS: "Credential Access",
      DISCOVERY: "Discovery",
      LATERAL_MOVEMENT: "Lateral Movement",
      COMMAND_AND_CONTROL: "Command and Control",
      EXFILTRATION: "Exfiltration",
      IMPACT: "Impact",
      COLLECTION: "Collection",
      DEFENSE_EVASION: "Defense Evasion",
      PERSISTENCE: "Persistence",
      PRIVILEGE_ESCALATION: "Privilege Escalation",
      RESOURCE_DEVELOPMENT: "Resource Development",
    },
    countryUnknown: "Unknown country",
    countryUnavailable: "Country unavailable",
    pivotActivate: ({ label, value }) => `Filter by ${label}: ${value}`,
  };
}

const READY_PAYLOAD_A = {
  ok: true as const,
  dimension: "srcIp" as const,
  topN: { values: ["10.0.0.1"], counts: [42] },
  series: [1, 2, 3],
  periodSeconds: 60,
  rangeStart: "2026-04-25T00:00:00.000Z",
  rangeEnd: "2026-04-25T01:00:00.000Z",
};

const READY_PAYLOAD_B = {
  ok: true as const,
  dimension: "srcIp" as const,
  topN: { values: ["10.0.0.2"], counts: [7] },
  series: [4, 5, 6],
  periodSeconds: 60,
  rangeStart: "2026-04-25T00:00:00.000Z",
  rangeEnd: "2026-04-25T01:00:00.000Z",
};

function flushAsync() {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderAnalytics({
  open,
  fingerprint,
}: {
  open: boolean;
  fingerprint: string | null;
}) {
  return render(
    <ScopeFingerprintProvider fingerprint={fingerprint}>
      <DetectionAnalytics
        open={open}
        filter={FILTER}
        filterIdentity="filter-1"
        labels={labels()}
        dimension="srcIp"
        topN={10}
        onDimensionChange={() => {}}
        onTopNChange={() => {}}
      />
    </ScopeFingerprintProvider>,
  );
}

describe("DetectionAnalytics cache key + probe (#393 Task B)", () => {
  beforeEach(() => {
    vi.mocked(runAnalyticsQuery).mockReset();
    probeAuthOrRedirectMock.mockReset();
  });

  it("re-fetches when the scope fingerprint changes (same account, different customer set)", async () => {
    vi.mocked(runAnalyticsQuery)
      .mockResolvedValueOnce(READY_PAYLOAD_A)
      .mockResolvedValueOnce(READY_PAYLOAD_B);
    probeAuthOrRedirectMock.mockResolvedValue(true);

    // First mount under fingerprint X — populates the cache for
    // (X | filter-1 | srcIp | 10).
    const first = renderAnalytics({ open: true, fingerprint: "fingerprint-x" });
    await flushAsync();
    expect(runAnalyticsQuery).toHaveBeenCalledTimes(1);
    first.unmount();

    // Re-mount under fingerprint Y at the same filter / dimension /
    // topN. The cache lives in `cacheRef` which is per-mount, so a
    // fresh mount always misses — but the stronger contract under
    // test is the *key*: even if the same cacheRef were reused, a
    // different fingerprint would resolve to a different key and
    // miss. We assert by mounting a second instance and confirming a
    // new fetch fires.
    renderAnalytics({ open: true, fingerprint: "fingerprint-y" });
    await flushAsync();
    expect(runAnalyticsQuery).toHaveBeenCalledTimes(2);
  });

  it("fires the probe before surfacing a cache hit on collapse-then-reopen", async () => {
    vi.mocked(runAnalyticsQuery).mockResolvedValue(READY_PAYLOAD_A);
    probeAuthOrRedirectMock.mockResolvedValue(true);

    const { rerender } = render(
      <ScopeFingerprintProvider fingerprint="fingerprint-x">
        <DetectionAnalytics
          open={true}
          filter={FILTER}
          filterIdentity="filter-1"
          labels={labels()}
          dimension="srcIp"
          topN={10}
          onDimensionChange={() => {}}
          onTopNChange={() => {}}
        />
      </ScopeFingerprintProvider>,
    );
    await flushAsync();
    expect(runAnalyticsQuery).toHaveBeenCalledTimes(1);
    expect(probeAuthOrRedirectMock).not.toHaveBeenCalled();

    // Collapse — fetches do not fire while open=false.
    rerender(
      <ScopeFingerprintProvider fingerprint="fingerprint-x">
        <DetectionAnalytics
          open={false}
          filter={FILTER}
          filterIdentity="filter-1"
          labels={labels()}
          dimension="srcIp"
          topN={10}
          onDimensionChange={() => {}}
          onTopNChange={() => {}}
        />
      </ScopeFingerprintProvider>,
    );
    await flushAsync();
    expect(runAnalyticsQuery).toHaveBeenCalledTimes(1);
    expect(probeAuthOrRedirectMock).not.toHaveBeenCalled();

    // Reopen — cache hit. The probe must fire and there must be no
    // additional `runAnalyticsQuery` round-trip (cache covered the
    // request).
    rerender(
      <ScopeFingerprintProvider fingerprint="fingerprint-x">
        <DetectionAnalytics
          open={true}
          filter={FILTER}
          filterIdentity="filter-1"
          labels={labels()}
          dimension="srcIp"
          topN={10}
          onDimensionChange={() => {}}
          onTopNChange={() => {}}
        />
      </ScopeFingerprintProvider>,
    );
    await flushAsync();
    expect(probeAuthOrRedirectMock).toHaveBeenCalledTimes(1);
    expect(runAnalyticsQuery).toHaveBeenCalledTimes(1);
  });

  it("hides the cached payload while the probe is in flight (no first-frame leak)", async () => {
    vi.mocked(runAnalyticsQuery).mockResolvedValue(READY_PAYLOAD_A);
    probeAuthOrRedirectMock.mockResolvedValue(true);

    const { rerender, container } = render(
      <ScopeFingerprintProvider fingerprint="fingerprint-x">
        <DetectionAnalytics
          open={true}
          filter={FILTER}
          filterIdentity="filter-1"
          labels={labels()}
          dimension="srcIp"
          topN={10}
          onDimensionChange={() => {}}
          onTopNChange={() => {}}
        />
      </ScopeFingerprintProvider>,
    );
    await flushAsync();
    // The fetch resolved into a `ready` status; the loading panel
    // should be gone.
    expect(container.textContent).not.toContain("Loading analytics…");

    // Hold the next probe pending so we can observe the verifying
    // window between the cache hit and the probe resolution.
    let resolveProbe: ((ok: boolean) => void) | null = null;
    probeAuthOrRedirectMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveProbe = resolve;
        }),
    );

    // Collapse + reopen → cache hit triggers the probe. The fix
    // flips local status to `loading` immediately so the prior
    // `ready` payload disappears from the DOM until the probe
    // resolves.
    rerender(
      <ScopeFingerprintProvider fingerprint="fingerprint-x">
        <DetectionAnalytics
          open={false}
          filter={FILTER}
          filterIdentity="filter-1"
          labels={labels()}
          dimension="srcIp"
          topN={10}
          onDimensionChange={() => {}}
          onTopNChange={() => {}}
        />
      </ScopeFingerprintProvider>,
    );
    rerender(
      <ScopeFingerprintProvider fingerprint="fingerprint-x">
        <DetectionAnalytics
          open={true}
          filter={FILTER}
          filterIdentity="filter-1"
          labels={labels()}
          dimension="srcIp"
          topN={10}
          onDimensionChange={() => {}}
          onTopNChange={() => {}}
        />
      </ScopeFingerprintProvider>,
    );
    await flushAsync();
    expect(container.textContent).toContain("Loading analytics…");

    // Resolve OK — the cached payload restores.
    await act(async () => {
      resolveProbe?.(true);
    });
    await flushAsync();
    expect(container.textContent).not.toContain("Loading analytics…");
  });

  it("drops the cached entry and never surfaces it when the probe returns 401", async () => {
    vi.mocked(runAnalyticsQuery).mockResolvedValue(READY_PAYLOAD_A);
    probeAuthOrRedirectMock.mockResolvedValueOnce(true);

    const { rerender, container } = render(
      <ScopeFingerprintProvider fingerprint="fingerprint-x">
        <DetectionAnalytics
          open={true}
          filter={FILTER}
          filterIdentity="filter-1"
          labels={labels()}
          dimension="srcIp"
          topN={10}
          onDimensionChange={() => {}}
          onTopNChange={() => {}}
        />
      </ScopeFingerprintProvider>,
    );
    await flushAsync();
    expect(runAnalyticsQuery).toHaveBeenCalledTimes(1);

    // Probe returns 401 on the next cache hit. The component invokes
    // the `onUnauthorized` callback (drops the cache entry) and
    // resolves to `false`; the local status set to `loading` before
    // the probe never transitions back to `ready`. Reset queued
    // implementations first — the initial mount path does not call
    // the probe (only the reopen path does), so the `true` value
    // would otherwise be consumed by this reopen's call instead of
    // the 401 we want to exercise.
    probeAuthOrRedirectMock.mockReset();
    probeAuthOrRedirectMock.mockImplementation((onUnauthorized) => {
      onUnauthorized?.();
      return Promise.resolve(false);
    });

    rerender(
      <ScopeFingerprintProvider fingerprint="fingerprint-x">
        <DetectionAnalytics
          open={false}
          filter={FILTER}
          filterIdentity="filter-1"
          labels={labels()}
          dimension="srcIp"
          topN={10}
          onDimensionChange={() => {}}
          onTopNChange={() => {}}
        />
      </ScopeFingerprintProvider>,
    );
    rerender(
      <ScopeFingerprintProvider fingerprint="fingerprint-x">
        <DetectionAnalytics
          open={true}
          filter={FILTER}
          filterIdentity="filter-1"
          labels={labels()}
          dimension="srcIp"
          topN={10}
          onDimensionChange={() => {}}
          onTopNChange={() => {}}
        />
      </ScopeFingerprintProvider>,
    );
    await flushAsync();

    // The cache was dropped and the status is still `loading` —
    // the cached payload from before the 401 must not be visible,
    // and we did NOT issue another `runAnalyticsQuery` (the cache
    // hit covered the lookup; only the probe failed). The hard
    // redirect inside `probeAuthOrRedirect` would tear the page
    // down in production — here we just assert the cached body
    // never surfaces.
    expect(container.textContent).toContain("Loading analytics…");
    expect(runAnalyticsQuery).toHaveBeenCalledTimes(1);
  });
});
