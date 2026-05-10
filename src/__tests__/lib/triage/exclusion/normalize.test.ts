import { describe, expect, it } from "vitest";

import { normalizeEventColumns } from "@/lib/triage/exclusion";
import type { TriageEvent } from "@/lib/triage/types";

function ev(overrides: Partial<TriageEvent>): TriageEvent {
  return {
    __typename: "PortScan",
    time: "2026-05-09T12:00:00.000Z",
    sensor: "sensor-a",
    category: null,
    level: "MEDIUM",
    ...overrides,
  };
}

describe("normalizeEventColumns — event-kind to column mapping", () => {
  it("populates host and uri for HTTP-shaped subtypes", () => {
    const cols = normalizeEventColumns(
      ev({
        __typename: "HttpThreat",
        origAddr: "10.0.0.1",
        respAddr: "10.0.0.2",
        host: "example.com",
        uri: "/path/to/resource",
      }),
    );
    expect(cols).toEqual({
      origAddr: "10.0.0.1",
      respAddr: "10.0.0.2",
      host: "example.com",
      dnsQuery: null,
      uri: "/path/to/resource",
    });
  });

  it("populates host from serverName for TLS-shaped subtypes (no uri / dns_query)", () => {
    const cols = normalizeEventColumns(
      ev({
        __typename: "BlocklistTls",
        origAddr: "10.0.0.3",
        serverName: "internal.tls.example",
      }),
    );
    expect(cols.host).toBe("internal.tls.example");
    expect(cols.dnsQuery).toBeNull();
    expect(cols.uri).toBeNull();
  });

  it("populates dnsQuery from query for DNS-shaped subtypes (no host / uri)", () => {
    const cols = normalizeEventColumns(
      ev({
        __typename: "DnsCovertChannel",
        origAddr: "10.0.0.4",
        query: "tunnel.example.com",
      }),
    );
    expect(cols.dnsQuery).toBe("tunnel.example.com");
    expect(cols.host).toBeNull();
    expect(cols.uri).toBeNull();
  });

  it("leaves host / dnsQuery / uri NULL for NTLM (IP-only carve-out)", () => {
    const cols = normalizeEventColumns(
      ev({
        __typename: "BlocklistNtlm",
        origAddr: "10.0.0.5",
        respAddr: "10.0.0.6",
        // Even if a hostname-like field were present, NTLM stays IP-only
        // by design (anchored in aicers/review-database#723).
      } as TriageEvent),
    );
    expect(cols.host).toBeNull();
    expect(cols.dnsQuery).toBeNull();
    expect(cols.uri).toBeNull();
    expect(cols.origAddr).toBe("10.0.0.5");
    expect(cols.respAddr).toBe("10.0.0.6");
  });

  it("leaves all host-like columns NULL for IP-only kinds (PortScan)", () => {
    const cols = normalizeEventColumns(
      ev({ __typename: "PortScan", origAddr: "10.0.0.7" }),
    );
    expect(cols.host).toBeNull();
    expect(cols.dnsQuery).toBeNull();
    expect(cols.uri).toBeNull();
    expect(cols.origAddr).toBe("10.0.0.7");
  });

  it("treats empty-string host / uri / serverName / query as null", () => {
    const cols = normalizeEventColumns(
      ev({
        __typename: "HttpThreat",
        host: "",
        uri: "",
      }),
    );
    expect(cols.host).toBeNull();
    expect(cols.uri).toBeNull();
  });
});
