/**
 * Verifies the prop chain from {@link EventInvestigation} →
 * {@link OverviewTab} → {@link AimerBanner} forwards `locator`,
 * `candidates`, `customerBridgeEligible`, and `aimerSetup` unchanged.
 *
 * `AimerBanner` is mocked out so the test can assert the exact props
 * the wrapper hands it without rendering any of the modal / fetch
 * machinery.
 */

import { render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));

const aimerBannerCalls: unknown[] = [];
vi.mock("@/components/events/aimer-banner", () => ({
  AimerBanner: (props: unknown) => {
    aimerBannerCalls.push(props);
    return <div data-testid="aimer-banner-mock" />;
  },
}));

import {
  EventInvestigation,
  type EventInvestigationLabels,
} from "@/components/events/event-investigation";
import { OverviewTab } from "@/components/events/tabs/overview-tab";
import enMessages from "@/i18n/messages/en.json";
import type { AimerCustomerCandidate } from "@/lib/aimer/candidate-customers";
import type { AimerIntegrationSetupStatus } from "@/lib/aimer/setup-status";
import type { Event } from "@/lib/detection/types";
import type { EventLocator } from "@/lib/events/event-locator";

const LOCATOR: EventLocator = {
  sensor: "sensor-1",
  time: "2026-04-22T10:00:00.000000000Z",
  origAddr: "10.0.0.5",
  origPort: 54321,
  respAddr: "203.0.113.45",
  respPort: 80,
  proto: 6,
  kind: "HttpThreat",
  level: "HIGH",
};

const EVENT: Event = {
  __typename: "HttpThreat",
  time: "2026-04-22T10:00:00.000000000Z",
  sensor: "sensor-1",
  confidence: 0.8,
  category: null,
  level: "HIGH",
  triageScores: null,
} as Event;

const CANDIDATES: AimerCustomerCandidate[] = [
  { id: 1, name: "Acme" },
  { id: 2, name: "Beta" },
];

const ELIGIBLE: Record<number, boolean> = { 1: true, 2: false };

const AIMER_SETUP: AimerIntegrationSetupStatus = {
  configured: false,
  missingReasons: ["bridgeUrl"],
};

const OVERVIEW_LABELS = {
  summary: "Summary",
  time: "Time",
  kind: "Kind",
  category: "Category",
  level: "Level",
  confidence: "Confidence",
  triageScores: "Triage",
  noTriage: "No triage",
  pivotsTitle: "Pivots",
  pivotSameSource: "Same source",
  pivotSameDestination: "Same destination",
  pivotSameKind: "Same kind",
};

describe("OverviewTab → AimerBanner prop forwarding", () => {
  it("forwards locator, candidates, customerBridgeEligible, and aimerSetup unchanged", () => {
    aimerBannerCalls.length = 0;
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <OverviewTab
          event={EVENT}
          locator={LOCATOR}
          labels={OVERVIEW_LABELS}
          candidates={CANDIDATES}
          customerBridgeEligible={ELIGIBLE}
          aimerSetup={AIMER_SETUP}
        />
      </NextIntlClientProvider>,
    );
    expect(aimerBannerCalls).toHaveLength(1);
    const props = aimerBannerCalls[0] as {
      locator: EventLocator;
      candidates: AimerCustomerCandidate[];
      customerBridgeEligible: Record<number, boolean>;
      aimerSetup: AimerIntegrationSetupStatus;
    };
    expect(props.locator).toBe(LOCATOR);
    expect(props.candidates).toBe(CANDIDATES);
    expect(props.customerBridgeEligible).toBe(ELIGIBLE);
    expect(props.aimerSetup).toBe(AIMER_SETUP);
  });
});

describe("EventInvestigation → OverviewTab forwarding", () => {
  it("threads candidates, customerBridgeEligible, and aimerSetup through to the AimerBanner", () => {
    aimerBannerCalls.length = 0;
    const fullLabels = buildFullLabels();
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <EventInvestigation
          event={EVENT}
          locator={LOCATOR}
          multipleMatches={false}
          backHref="/detection"
          labels={fullLabels}
          candidates={CANDIDATES}
          customerBridgeEligible={ELIGIBLE}
          aimerSetup={AIMER_SETUP}
        />
      </NextIntlClientProvider>,
    );
    expect(aimerBannerCalls).toHaveLength(1);
    const props = aimerBannerCalls[0] as {
      locator: EventLocator;
      candidates: AimerCustomerCandidate[];
      customerBridgeEligible: Record<number, boolean>;
      aimerSetup: AimerIntegrationSetupStatus;
    };
    expect(props.locator).toBe(LOCATOR);
    expect(props.candidates).toBe(CANDIDATES);
    expect(props.customerBridgeEligible).toBe(ELIGIBLE);
    expect(props.aimerSetup).toBe(AIMER_SETUP);
  });
});

function buildFullLabels(): EventInvestigationLabels {
  const e = "";
  return {
    back: e,
    severity: e,
    time: e,
    confidence: e,
    multipleNotice: e,
    tabs: {
      overview: "Overview",
      endpoints: e,
      protocol: e,
      payload: e,
      context: e,
      related: e,
    },
    overview: OVERVIEW_LABELS,
    endpoints: {
      source: e,
      destination: e,
      ip: e,
      country: e,
      region: e,
      city: e,
      coordinates: e,
      ports: e,
      company: e,
      companySourceCustomer: e,
      companySourceNetwork: e,
      companySourceIsp: e,
      noCompany: e,
      loading: e,
      map: { title: e, sourceLegend: e, destinationLegend: e },
    },
    protocol: {
      noFields: e,
      http: {
        request: e,
        response: e,
        auth: e,
        body: e,
        fields: {
          method: e,
          host: e,
          uri: e,
          referer: e,
          version: e,
          userAgent: e,
          requestLen: e,
          statusCode: e,
          statusMsg: e,
          responseLen: e,
          contentEncoding: e,
          contentType: e,
          cacheControl: e,
          username: e,
          password: e,
          cookie: e,
          filenames: e,
          mimeTypes: e,
          content: e,
          body: e,
        },
      },
      dns: {
        query: e,
        response: e,
        flags: e,
        fields: {
          query: e,
          queryClass: e,
          queryType: e,
          transactionId: e,
          roundTripTime: e,
          answer: e,
          responseCode: e,
          ttl: e,
          authoritative: e,
          truncated: e,
          recursionDesired: e,
          recursionAvailable: e,
        },
      },
      scan: {
        targets: e,
        duration: e,
        fields: { scannedPorts: e, startTime: e, endTime: e },
      },
      ftp: {
        users: e,
        duration: e,
        fields: { userList: e, startTime: e, endTime: e },
      },
      ftpPlainText: {
        auth: e,
        duration: e,
        session: e,
        fields: {
          user: e,
          password: e,
          startTime: e,
          duration: e,
          commands: e,
        },
      },
      multiHostScan: {
        targets: e,
        duration: e,
        fields: { respAddrs: e, respPort: e, startTime: e, endTime: e },
      },
      network: {
        title: e,
        fields: {
          service: e,
          attackKind: e,
          content: e,
          startTime: e,
          duration: e,
        },
      },
      blocklist: {
        title: e,
        fields: {
          state: e,
          service: e,
          startTime: e,
          duration: e,
          origBytes: e,
          respBytes: e,
          origPkts: e,
          respPkts: e,
        },
      },
    },
    payload: {
      title: e,
      description: e,
      size: e,
      bytes: e,
      download: e,
      downloadName: e,
    },
    context: {
      threatName: e,
      threatCategory: e,
      threatLevel: e,
      explanation: e,
      mitre: e,
      tactic: e,
      technique: e,
      subTechnique: e,
      none: e,
    },
    related: {
      sameSource: e,
      sameDestination: e,
      sameKind: e,
      sameSession: e,
      lastDay: e,
      lastWeek: e,
      openInSearch: e,
      loading: e,
      count: e,
      lastSeen: e,
      none: e,
      note: e,
    },
  };
}
