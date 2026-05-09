import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Stub the server action so the SSR pass does not pull in the
// "use server" module graph (which the test runner would refuse to
// import outside a Next.js context).
vi.mock("@/app/[locale]/(dashboard)/detection/analytics-actions", () => ({
  runAnalyticsQuery: vi.fn(),
}));

import {
  DetectionAnalytics,
  type DetectionAnalyticsLabels,
} from "@/components/detection/detection-analytics";
import type { Filter } from "@/lib/detection/filter";

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

const FILTER: Filter = {
  mode: "structured",
  input: { start: null, end: null },
};

describe("DetectionAnalytics", () => {
  it("renders nothing when collapsed (no fetch is dispatched while closed)", () => {
    const html = renderToStaticMarkup(
      <DetectionAnalytics
        open={false}
        filter={FILTER}
        filterIdentity="x"
        labels={labels()}
        dimension="srcIp"
        topN={10}
        onDimensionChange={() => {}}
        onTopNChange={() => {}}
      />,
    );
    expect(html).toBe("");
  });

  it("renders the dimension + Top N selectors when expanded", () => {
    const html = renderToStaticMarkup(
      <DetectionAnalytics
        open={true}
        filter={FILTER}
        filterIdentity="x"
        labels={labels()}
        dimension="srcIp"
        topN={10}
        onDimensionChange={() => {}}
        onTopNChange={() => {}}
      />,
    );
    // Two Radix `<button role="combobox">` triggers — one for the
    // dimension, one for the Top N count — proves the strip mounted
    // its selectors. Radix portals the actual options out of the
    // SSR tree, so we can only assert the trigger labels here.
    expect(html).toContain('id="detection-analytics-dimension-label"');
    expect(html).toContain('id="detection-analytics-top-n-label"');
    expect(html).toContain(
      'aria-labelledby="detection-analytics-dimension-label"',
    );
    expect(html).toContain('aria-labelledby="detection-analytics-top-n-label"');
  });

  it("shows the loading panel as the initial body — useEffect has not flushed yet in SSR", () => {
    const html = renderToStaticMarkup(
      <DetectionAnalytics
        open={true}
        filter={FILTER}
        filterIdentity="x"
        labels={labels()}
        dimension="srcIp"
        topN={10}
        onDimensionChange={() => {}}
        onTopNChange={() => {}}
      />,
    );
    expect(html).toContain("Loading analytics…");
  });
});
