import { describe, expect, it } from "vitest";

import {
  pickHighlightValues,
  QUICK_PEEK_HIGHLIGHTS,
} from "@/lib/detection/quick-peek-highlights";
import type { Event } from "@/lib/detection/types";

function baseEvent(overrides: Record<string, unknown> = {}): Event {
  return {
    __typename: "HttpThreat",
    time: "2026-04-22T00:00:00.000Z",
    sensor: "sensor-1",
    confidence: 0.8,
    category: null,
    level: "HIGH",
    triageScores: null,
    ...overrides,
  } as unknown as Event;
}

describe("pickHighlightValues", () => {
  it("returns an empty list for subtypes without highlights", () => {
    const event = baseEvent({ __typename: "WindowsThreat" });
    expect(pickHighlightValues(event)).toEqual([]);
  });

  it("returns HTTP highlight fields for HttpThreat", () => {
    const event = baseEvent({
      __typename: "HttpThreat",
      method: "GET",
      host: "example.com",
      uri: "/login",
      statusCode: 200,
    });
    const highlights = pickHighlightValues(event);
    const labelKeys = highlights.map((h) => h.labelKey);
    expect(labelKeys).toContain("httpMethod");
    expect(labelKeys).toContain("httpHost");
    expect(labelKeys).toContain("httpUri");
    expect(labelKeys).toContain("httpStatusCode");
  });

  it("hides empty string values (per the issue's 'prefer hiding over Not Provided' rule)", () => {
    const event = baseEvent({
      __typename: "HttpThreat",
      method: "",
      host: "example.com",
      uri: "",
      statusCode: 200,
    });
    const highlights = pickHighlightValues(event);
    const labelKeys = highlights.map((h) => h.labelKey);
    expect(labelKeys).not.toContain("httpMethod");
    expect(labelKeys).toContain("httpHost");
    expect(labelKeys).not.toContain("httpUri");
    expect(labelKeys).toContain("httpStatusCode");
  });

  it("keeps boolean values even when they are false", () => {
    // `isInternal: false` on FtpBruteForce is meaningful (the flag
    // is explicitly not-internal) — it must render rather than fall
    // out with the empty-string values.
    const event = baseEvent({
      __typename: "FtpBruteForce",
      isInternal: false,
    });
    const highlights = pickHighlightValues(event);
    expect(highlights.find((h) => h.labelKey === "isInternal")?.value).toBe(
      false,
    );
  });

  it("returns array values for list-type fields", () => {
    const event = baseEvent({
      __typename: "FtpBruteForce",
      userList: ["alice", "bob", "carol"],
    });
    const highlight = pickHighlightValues(event).find(
      (h) => h.labelKey === "userList",
    );
    expect(highlight?.value).toEqual(["alice", "bob", "carol"]);
  });

  it("maps each acceptance-list subtype to at least one highlight field", () => {
    // Acceptance: Peek content renders correctly for at least
    // HttpThreat, TlsSpoofing (mapped to SuspiciousTlsTraffic),
    // DnsCovertChannel, FtpBruteForce, RdpBruteForce, PortScan,
    // ExternalDdos, and a Blocklist* example (BlocklistHttp).
    const required = [
      "HttpThreat",
      "SuspiciousTlsTraffic",
      "DnsCovertChannel",
      "FtpBruteForce",
      "RdpBruteForce",
      "PortScan",
      "ExternalDdos",
      "BlocklistHttp",
    ];
    for (const kind of required) {
      expect(
        QUICK_PEEK_HIGHLIGHTS[kind],
        `expected highlights for ${kind}`,
      ).toBeDefined();
      expect(QUICK_PEEK_HIGHLIGHTS[kind].length).toBeGreaterThan(0);
    }
  });

  it("keeps each subtype's highlight list under the issue's ~10 field cap", () => {
    // Issue #290: "Per subtype keep under ~10 fields; the rest
    // belongs to the Investigation view."
    for (const [kind, entries] of Object.entries(QUICK_PEEK_HIGHLIGHTS)) {
      expect(
        entries.length,
        `${kind} highlight count should stay under 10`,
      ).toBeLessThanOrEqual(10);
    }
  });
});
