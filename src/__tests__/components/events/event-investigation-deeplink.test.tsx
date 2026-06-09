/**
 * #728: the quick-peek "Open packet detail" action deep-links to
 * `?tab=pcap`. `EventInvestigation` must open directly on the PCAP tab
 * when `initialTab="pcap"` (no manual tab click), and fall back to
 * Overview for an unknown / unavailable tab value.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/components/events/aimer-banner", () => ({
  AimerBanner: () => <div data-testid="aimer-banner-mock" />,
}));

const loadEventPcapMock = vi.fn();
vi.mock("@/lib/detection/pcap-view", () => ({
  loadEventPcap: (...args: unknown[]) => loadEventPcapMock(...args),
}));

import {
  EventInvestigation,
  type EventInvestigationLabels,
} from "@/components/events/event-investigation";
import enMessages from "@/i18n/messages/en.json";
import type { Event } from "@/lib/detection/types";
import type { EventLocator } from "@/lib/events/event-locator";

const LOCATOR: EventLocator = { id: "evt-AAAA" };

const EVENT: Event = {
  __typename: "HttpThreat",
  id: "evt-AAAA",
  time: "2026-04-22T10:00:00.000Z",
  sensor: "sensor-1",
  confidence: 0.8,
  category: null,
  level: "HIGH",
  triageScores: null,
} as Event;

function renderInvestigation(initialTab?: string) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <EventInvestigation
        event={EVENT}
        locator={LOCATOR}
        backHref="/detection"
        labels={buildLabels()}
        initialTab={initialTab}
        candidates={[]}
        customerBridgeEligible={{}}
        aimerSetup={{ configured: false, missingReasons: [] }}
      />
    </NextIntlClientProvider>,
  );
}

describe("EventInvestigation deep link (#728)", () => {
  beforeEach(() => {
    loadEventPcapMock.mockReset();
    loadEventPcapMock.mockResolvedValue({ status: "ok", parsedPcap: "x" });
  });

  it("opens directly on the PCAP tab for ?tab=pcap and fires its load", async () => {
    renderInvestigation("pcap");
    const pcapTab = screen.getByRole("tab", { name: "PCAP" });
    expect(pcapTab.getAttribute("data-state")).toBe("active");
    // The PCAP tab content is mounted, so its lazy fetch runs.
    await waitFor(() =>
      expect(loadEventPcapMock).toHaveBeenCalledWith(
        "sensor-1",
        "2026-04-22T10:00:00.000Z",
      ),
    );
  });

  it("falls back to Overview when no initial tab is given", () => {
    renderInvestigation();
    expect(
      screen.getByRole("tab", { name: "Overview" }).getAttribute("data-state"),
    ).toBe("active");
    expect(loadEventPcapMock).not.toHaveBeenCalled();
  });

  it("falls back to Overview for an unknown tab value", () => {
    renderInvestigation("bogus");
    expect(
      screen.getByRole("tab", { name: "Overview" }).getAttribute("data-state"),
    ).toBe("active");
  });
});

function buildLabels(): EventInvestigationLabels {
  const e = "";
  return {
    back: e,
    severity: e,
    time: e,
    confidence: e,
    tabs: {
      overview: "Overview",
      endpoints: "Endpoints",
      protocol: "Protocol",
      payload: "Payload",
      pcap: "PCAP",
      context: "Context",
      related: "Related",
    },
    overview: {
      summary: e,
      time: e,
      kind: e,
      category: e,
      level: e,
      confidence: e,
      triageScores: e,
      noTriage: e,
      pivotsTitle: e,
      pivotSameSource: e,
      pivotSameDestination: e,
      pivotSameKind: e,
    },
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
    pcap: {
      title: "Packet capture",
      description: e,
      loading: "Loading packet capture…",
      empty: e,
      forbidden: e,
      unavailable: e,
      error: e,
      download: "Download .pcap",
      downloading: e,
      downloadError: e,
      downloadName: "detection.pcap",
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
