import { describe, expect, it } from "vitest";

import { hasProtocolData } from "@/components/events/tabs/protocol-tab";
import type { Event } from "@/lib/detection/types";

function makeEvent(typename: string): Event {
  return {
    __typename: typename,
    time: "2026-04-22T10:00:00.000000000Z",
    sensor: "sensor-1",
    confidence: 0.8,
    category: null,
    level: "HIGH",
    triageScores: null,
  } as Event;
}

describe("hasProtocolData", () => {
  it.each([
    "HttpThreat",
    "DnsCovertChannel",
    "BlocklistDns",
    "PortScan",
    "MultiHostPortScan",
    "FtpBruteForce",
    "FtpPlainText",
    "NetworkThreat",
    "BlocklistConn",
  ])("returns true for the rendered subtype %s", (typename) => {
    expect(hasProtocolData(makeEvent(typename))).toBe(true);
  });

  it("returns false for subtypes with no kind-specific renderer", () => {
    // Tab is hidden per #291's "tabs that have no data are hidden"
    // rule rather than painting an empty 'no fields' placeholder.
    expect(hasProtocolData(makeEvent("BlocklistRdp"))).toBe(false);
    expect(hasProtocolData(makeEvent("TorConnection"))).toBe(false);
    expect(hasProtocolData(makeEvent("WindowsThreat"))).toBe(false);
  });
});
