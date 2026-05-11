import { describe, expect, it } from "vitest";
import type { ScoredTriageEvent, TriageEvent } from "@/lib/triage";
import { aggregateTriageEvents } from "@/lib/triage";
import {
  buildPivotIndex,
  eventsMatchingFocusValues,
  getPivotDimension,
  lookupPivotEntry,
} from "@/lib/triage/pivot";
import { buildTier2Filter } from "@/lib/triage/tier2-filter";

let evSeq = 0;
function ev(overrides: Partial<TriageEvent>): TriageEvent {
  evSeq += 1;
  return {
    __typename: "NetworkThreat",
    id: `evt-${evSeq}`,
    time: "2026-05-09T12:00:00.000Z",
    sensor: "sensor-a",
    category: "EXFILTRATION",
    level: "MEDIUM",
    ...overrides,
  };
}

function scored(overrides: Partial<TriageEvent>): ScoredTriageEvent {
  return aggregateTriageEvents([ev(overrides)], false).events[0];
}

describe("pivot dimension extractors", () => {
  describe("externalIp / internalIp", () => {
    it("classifies originator/responder addresses by classifier output", () => {
      const event = scored({
        origAddr: "10.0.0.5", // private → internal
        respAddr: "203.0.113.5", // public → external
      });
      expect(
        getPivotDimension("internalIp")
          .extract(event)
          .map((v) => v.key),
      ).toEqual(["10.0.0.5"]);
      expect(
        getPivotDimension("externalIp")
          .extract(event)
          .map((v) => v.key),
      ).toEqual(["203.0.113.5"]);
    });

    it("dedupes when the same address appears on both sides", () => {
      const event = scored({
        origAddr: "10.0.0.1",
        respAddr: "10.0.0.1",
      });
      expect(getPivotDimension("internalIp").extract(event)).toHaveLength(1);
    });

    it("ignores `unknown` classification", () => {
      const event = scored({ origAddr: "not-an-ip" });
      expect(getPivotDimension("internalIp").extract(event)).toEqual([]);
      expect(getPivotDimension("externalIp").extract(event)).toEqual([]);
    });
  });

  describe("port", () => {
    it("extracts only respPort", () => {
      const event = scored({ origPort: 54321, respPort: 443 });
      expect(
        getPivotDimension("port")
          .extract(event)
          .map((v) => v.key),
      ).toEqual(["443"]);
    });

    it("returns empty when respPort is missing", () => {
      const event = scored({ origPort: 1234 });
      expect(getPivotDimension("port").extract(event)).toEqual([]);
    });
  });

  describe("country", () => {
    it("uppercases and dedupes both sides", () => {
      const event = scored({ origCountry: "us", respCountry: "US" });
      expect(
        getPivotDimension("country")
          .extract(event)
          .map((v) => v.key),
      ).toEqual(["US"]);
    });
  });

  describe("registrableDomain", () => {
    it("extracts from host, serverName, and DNS query", () => {
      const event = scored({
        host: "api.example.com",
      });
      expect(
        getPivotDimension("registrableDomain")
          .extract(event)
          .map((v) => v.key),
      ).toEqual(["example.com"]);
    });

    it("respects PSL multi-level suffixes", () => {
      const event = scored({ host: "a.example.co.uk" });
      expect(
        getPivotDimension("registrableDomain")
          .extract(event)
          .map((v) => v.key),
      ).toEqual(["example.co.uk"]);
    });

    it("dedupes domains across host / serverName / query", () => {
      const event = scored({
        host: "a.example.com",
        serverName: "b.example.com",
        query: "c.example.com",
      });
      expect(
        getPivotDimension("registrableDomain").extract(event),
      ).toHaveLength(1);
    });
  });

  describe("uriPattern", () => {
    it("templates IDs and strips queries", () => {
      const event = scored({ uri: "/api/v1/users/42?token=foo" });
      expect(
        getPivotDimension("uriPattern")
          .extract(event)
          .map((v) => v.key),
      ).toEqual(["/api/v1/users/{id}"]);
    });
  });

  describe("dnsAnswer", () => {
    it("splits comma-separated answers into separate values", () => {
      const event = scored({
        __typename: "BlocklistDns",
        answer: "1.2.3.4, 5.6.7.8",
      });
      expect(
        getPivotDimension("dnsAnswer")
          .extract(event)
          .map((v) => v.key),
      ).toEqual(["1.2.3.4", "5.6.7.8"]);
    });

    it("drops non-IP tokens (CNAMEs, status text)", () => {
      const event = scored({
        __typename: "BlocklistDns",
        // Mixed payload as REview can return: a CNAME alongside the
        // resolved A record, plus a status string from a refused query.
        answer: "cdn.example.com, 1.2.3.4, NXDOMAIN",
      });
      expect(
        getPivotDimension("dnsAnswer")
          .extract(event)
          .map((v) => v.key),
      ).toEqual(["1.2.3.4"]);
    });

    it("accepts IPv6 literals including IPv4-mapped form", () => {
      const event = scored({
        __typename: "BlocklistDns",
        answer: "2001:db8::1 ::ffff:1.2.3.4",
      });
      expect(
        getPivotDimension("dnsAnswer")
          .extract(event)
          .map((v) => v.key),
      ).toEqual(["2001:db8::1", "::ffff:1.2.3.4"]);
    });
  });

  describe("sameKindWithin15Min", () => {
    it("matches two same-kind events two minutes apart even across a 30-min boundary", () => {
      // Earlier (bucket-floor) implementations placed 12:29 and 12:31
      // into different 30-min buckets and refused to match them. The
      // dimension must answer ±15-min membership relative to the
      // focus event, not bucket coincidence.
      const focusEvent = ev({
        __typename: "HttpThreat",
        time: "2026-05-09T12:29:00.000Z",
      });
      const neighborEvent = ev({
        __typename: "HttpThreat",
        time: "2026-05-09T12:31:00.000Z",
      });
      const corpus = aggregateTriageEvents(
        [focusEvent, neighborEvent],
        false,
      ).events;
      const index = buildPivotIndex(corpus);
      const focusValueKey = getPivotDimension("sameKindWithin15Min").extract(
        corpus[0],
      )[0].key;
      const matched = eventsMatchingFocusValues(index, "sameKindWithin15Min", [
        focusValueKey,
      ]);
      expect(matched).toHaveLength(2);
    });

    it("does not match events of the same kind 16+ minutes apart", () => {
      // Earlier (bucket-floor) implementations placed 12:00 and 12:29
      // into the same 30-min bucket and called them a match — but
      // those are nearly 30 minutes apart and outside ±15 min.
      const focusEvent = ev({
        __typename: "HttpThreat",
        time: "2026-05-09T12:00:00.000Z",
      });
      const distantEvent = ev({
        __typename: "HttpThreat",
        time: "2026-05-09T12:29:00.000Z",
      });
      const corpus = aggregateTriageEvents(
        [focusEvent, distantEvent],
        false,
      ).events;
      const index = buildPivotIndex(corpus);
      const focusValueKey = getPivotDimension("sameKindWithin15Min").extract(
        corpus[0],
      )[0].key;
      const matched = eventsMatchingFocusValues(index, "sameKindWithin15Min", [
        focusValueKey,
      ]);
      expect(matched.map((m) => m.time)).toEqual(["2026-05-09T12:00:00.000Z"]);
    });

    it("matches at exactly the ±15-min edge", () => {
      const center = ev({
        __typename: "HttpThreat",
        time: "2026-05-09T12:00:00.000Z",
      });
      const onEdge = ev({
        __typename: "HttpThreat",
        time: "2026-05-09T12:15:00.000Z",
      });
      const justOver = ev({
        __typename: "HttpThreat",
        time: "2026-05-09T12:15:00.001Z",
      });
      const corpus = aggregateTriageEvents(
        [center, onEdge, justOver],
        false,
      ).events;
      const index = buildPivotIndex(corpus);
      const focusValueKey = getPivotDimension("sameKindWithin15Min").extract(
        corpus[0],
      )[0].key;
      const matched = eventsMatchingFocusValues(index, "sameKindWithin15Min", [
        focusValueKey,
      ]);
      const matchedTimes = matched.map((m) => m.time).sort();
      expect(matchedTimes).toEqual([
        "2026-05-09T12:00:00.000Z",
        "2026-05-09T12:15:00.000Z",
      ]);
    });

    it("does not merge events of different __typename within the window", () => {
      const httpA = ev({
        __typename: "HttpThreat",
        time: "2026-05-09T12:01:00.000Z",
      });
      const dnsA = ev({
        __typename: "BlocklistDns",
        time: "2026-05-09T12:01:00.000Z",
      });
      const corpus = aggregateTriageEvents([httpA, dnsA], false).events;
      const index = buildPivotIndex(corpus);
      const httpKey = getPivotDimension("sameKindWithin15Min").extract(
        corpus[0],
      )[0].key;
      const matched = eventsMatchingFocusValues(index, "sameKindWithin15Min", [
        httpKey,
      ]);
      expect(matched.every((m) => m.__typename === "HttpThreat")).toBe(true);
    });

    it("`lookupPivotEntry` resolves dynamically from the value key", () => {
      const a = ev({
        __typename: "HttpThreat",
        time: "2026-05-09T12:00:00.000Z",
      });
      const b = ev({
        __typename: "HttpThreat",
        time: "2026-05-09T12:10:00.000Z",
      });
      const c = ev({
        __typename: "HttpThreat",
        time: "2026-05-09T12:40:00.000Z",
      });
      const corpus = aggregateTriageEvents([a, b, c], false).events;
      const index = buildPivotIndex(corpus);
      const focusKey = getPivotDimension("sameKindWithin15Min").extract(
        corpus[0],
      )[0].key;
      const entry = lookupPivotEntry(index, "sameKindWithin15Min", focusKey);
      expect(entry?.events.map((e) => e.time).sort()).toEqual([
        "2026-05-09T12:00:00.000Z",
        "2026-05-09T12:10:00.000Z",
      ]);
    });
  });

  describe("categories (Tier-2-only)", () => {
    it("extracts the integer ordinal as the value key (round-trips through buildTier2Filter)", () => {
      const event = scored({ category: "COMMAND_AND_CONTROL" });
      const values = getPivotDimension("categories").extract(event);
      expect(values).toEqual([{ key: "7", label: "COMMAND_AND_CONTROL" }]);
      const filter = buildTier2Filter({
        periodStartIso: "2026-05-08T12:00:00.000Z",
        periodEndIso: "2026-05-09T12:00:00.000Z",
        dimension: "categories",
        valueKey: values[0].key,
      });
      expect(filter?.categories).toEqual([7]);
    });

    it("returns no values for events with a missing category", () => {
      const event = scored({ category: null });
      expect(getPivotDimension("categories").extract(event)).toEqual([]);
    });
  });

  describe("clusterId", () => {
    it("only emits a value when clusterId is non-empty", () => {
      expect(
        getPivotDimension("clusterId").extract(scored({ clusterId: "abc" })),
      ).toHaveLength(1);
      expect(
        getPivotDimension("clusterId").extract(scored({ clusterId: "" })),
      ).toEqual([]);
      expect(
        getPivotDimension("clusterId").extract(scored({ clusterId: null })),
      ).toEqual([]);
    });
  });
});
