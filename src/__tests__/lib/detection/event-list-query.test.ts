import { print } from "graphql";
import { describe, expect, it } from "vitest";

import {
  type EventAddressing,
  readEventAddressing,
} from "@/components/events/event-display-helpers";
import { EVENT_LIST_QUERY } from "@/lib/detection/queries";
import type { EventBase } from "@/lib/detection/types";

describe("EVENT_LIST_QUERY", () => {
  it("includes a per-typename inline fragment for every curated subtype", () => {
    const printed = print(EVENT_LIST_QUERY);
    // Curated typenames the result list dispatches on (Detection-2).
    const required = [
      "BlocklistConn",
      "BlocklistDns",
      "DnsCovertChannel",
      "DomainGenerationAlgorithm",
      "ExternalDdos",
      "FtpBruteForce",
      "FtpPlainText",
      "HttpThreat",
      "LdapBruteForce",
      "MultiHostPortScan",
      "NetworkThreat",
      "NonBrowser",
      "PortScan",
      "RdpBruteForce",
      "RepeatedHttpSessions",
      "SuspiciousTlsTraffic",
      "TorConnection",
      "TorConnectionConn",
      "WindowsThreat",
    ];
    for (const t of required) {
      expect(printed).toContain(`... on ${t}`);
    }
  });

  it("selects attackKind on the four ML subtypes that expose it", () => {
    const printed = print(EVENT_LIST_QUERY);
    for (const t of ["HttpThreat", "NetworkThreat", "WindowsThreat"]) {
      const idx = printed.indexOf(`... on ${t}`);
      const next = printed.indexOf("... on", idx + 1);
      const block = next > 0 ? printed.slice(idx, next) : printed.slice(idx);
      expect(block).toContain("attackKind");
    }
  });

  it("uses array variants where the schema models multiple endpoints", () => {
    const printed = print(EVENT_LIST_QUERY);
    // ExternalDdos collapses originator into an array.
    const ext = printed.indexOf("... on ExternalDdos");
    expect(printed.slice(ext, ext + 250)).toContain("origAddrs");
    expect(printed.slice(ext, ext + 250)).toContain("origCountries");
    // PortScan exposes respPorts (plural) instead of respPort.
    const ps = printed.indexOf("... on PortScan");
    expect(printed.slice(ps, ps + 250)).toContain("respPorts");
  });
});

describe("readEventAddressing", () => {
  function makeBase(__typename: string): EventBase {
    return {
      __typename,
      time: "2026-04-22T00:00:00.000Z",
      sensor: "sensor-1",
      confidence: 0.91,
      category: null,
      level: "MEDIUM",
      triageScores: null,
    };
  }

  it("returns nulls / empty arrays for a base event with no addressing", () => {
    const a: EventAddressing = readEventAddressing(makeBase("WindowsThreat"));
    expect(a.origAddr).toBeNull();
    expect(a.origAddrs).toEqual([]);
    expect(a.respPort).toBeNull();
    expect(a.respPorts).toEqual([]);
    expect(a.attackKind).toBeNull();
  });

  it("reads singular addressing fields from a typical subtype", () => {
    const evt = {
      ...makeBase("HttpThreat"),
      origAddr: "10.0.0.5",
      origPort: 49152,
      origCountry: "US",
      respAddr: "203.0.113.45",
      respPort: 443,
      respCountry: "DE",
      proto: 6,
      attackKind: "SQL Injection",
    };
    const a = readEventAddressing(evt as unknown as EventBase);
    expect(a.origAddr).toBe("10.0.0.5");
    expect(a.origPort).toBe(49152);
    expect(a.respCountry).toBe("DE");
    expect(a.attackKind).toBe("SQL Injection");
  });

  it("reads plural endpoint arrays for fan-out subtypes", () => {
    const evt = {
      ...makeBase("MultiHostPortScan"),
      origAddr: "10.0.0.5",
      origCountry: "US",
      respAddrs: ["203.0.113.1", "203.0.113.2"],
      respCountries: ["DE", "FR"],
      respPort: 22,
      proto: 6,
    };
    const a = readEventAddressing(evt as unknown as EventBase);
    expect(a.origAddr).toBe("10.0.0.5");
    expect(a.respAddrs).toEqual(["203.0.113.1", "203.0.113.2"]);
    expect(a.respCountries).toEqual(["DE", "FR"]);
    expect(a.respPort).toBe(22);
  });
});
