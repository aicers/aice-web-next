import { describe, expect, it } from "vitest";

import {
  EVENT_KIND_FRIENDLY_NAMES,
  formatEndpointSummary,
} from "@/components/events/event-display-helpers";
import type { Event } from "@/lib/detection/types";

function makeEvent(typename: string, extra: Record<string, unknown>): Event {
  return {
    __typename: typename,
    time: "2026-04-22T10:00:00.000000000Z",
    sensor: "sensor-1",
    confidence: 0.8,
    category: null,
    level: "HIGH",
    triageScores: null,
    ...extra,
  } as Event;
}

describe("formatEndpointSummary", () => {
  it("renders A → B for singular address subtypes", () => {
    const event = makeEvent("HttpThreat", {
      origAddr: "10.0.0.5",
      respAddr: "203.0.113.45",
    });
    expect(formatEndpointSummary(event)).toBe("10.0.0.5 → 203.0.113.45");
  });

  it("renders single responder and a +N suffix for MultiHostPortScan", () => {
    const event = makeEvent("MultiHostPortScan", {
      origAddr: "10.0.0.5",
      respAddrs: ["203.0.113.45", "203.0.113.46", "203.0.113.47"],
    });
    expect(formatEndpointSummary(event)).toBe("10.0.0.5 → 203.0.113.45 +2");
  });

  it("renders single responder without a suffix when respAddrs has one entry", () => {
    const event = makeEvent("RdpBruteForce", {
      origAddr: "10.0.0.5",
      respAddrs: ["203.0.113.45"],
    });
    expect(formatEndpointSummary(event)).toBe("10.0.0.5 → 203.0.113.45");
  });

  it("renders single originator and a +N suffix for ExternalDdos", () => {
    const event = makeEvent("ExternalDdos", {
      origAddrs: ["10.0.0.5", "10.0.0.6"],
      respAddr: "203.0.113.45",
    });
    expect(formatEndpointSummary(event)).toBe("10.0.0.5 → 203.0.113.45 +1");
  });

  it("returns null when neither side carries an address", () => {
    const event = makeEvent("WindowsThreat", {});
    expect(formatEndpointSummary(event)).toBeNull();
  });

  it("renders a `—` placeholder when only the originator is addressable", () => {
    const event = makeEvent("MultiHostPortScan", {
      origAddr: "10.0.0.5",
      respAddrs: [],
    });
    expect(formatEndpointSummary(event)).toBe("10.0.0.5 → —");
  });

  it("renders a `—` placeholder when only the responder is addressable", () => {
    // `UnusualDestinationPattern` is responder-array only in the
    // vendored schema — Quick peek still needs an endpoint summary
    // so the inspector does not silently drop what the list row
    // just showed as `— → <responder>`.
    const event = makeEvent("UnusualDestinationPattern", {
      respAddrs: ["203.0.113.45", "203.0.113.46"],
    });
    expect(formatEndpointSummary(event)).toBe("— → 203.0.113.45 +1");
  });
});

describe("EVENT_KIND_FRIENDLY_NAMES", () => {
  // Every subtype rendered by a first-class Protocol tab renderer
  // must have a friendly heading — otherwise the header and Overview
  // fall back to the raw `__typename` for supported subtypes.
  it.each([
    ["BlocklistConn", "Blocklist Connection"],
    ["BlocklistDns", "Blocklist DNS"],
    ["DnsCovertChannel", "DNS Covert Channel"],
    ["FtpBruteForce", "FTP Brute Force"],
    ["FtpPlainText", "FTP Plain Text"],
    ["HttpThreat", "HTTP Threat"],
    ["MultiHostPortScan", "Multi-Host Port Scan"],
    ["NetworkThreat", "Network Threat"],
    ["PortScan", "Port Scan"],
    ["RdpBruteForce", "RDP Brute Force"],
  ])("maps %s to %s", (typename, friendly) => {
    expect(EVENT_KIND_FRIENDLY_NAMES[typename]).toBe(friendly);
  });
});
