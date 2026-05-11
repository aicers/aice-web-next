import { describe, expect, it } from "vitest";

import { aggregateTriageEvents, type TriageEvent } from "@/lib/triage";
import {
  buildPivotIndex,
  buildPivotPanel,
  PIVOT_GROUP_DEFAULT_ROWS,
  PIVOT_GROUP_EXPANDED_ROWS,
  pivotIndexFor,
} from "@/lib/triage/pivot";

let evSeq = 0;
function ev(overrides: Partial<TriageEvent>): TriageEvent {
  evSeq += 1;
  return {
    __typename: "HttpThreat",
    id: `evt-${evSeq}`,
    time: "2026-05-09T12:00:00.000Z",
    sensor: "sensor-a",
    category: "EXFILTRATION",
    level: "MEDIUM",
    ...overrides,
  };
}

describe("buildPivotIndex", () => {
  it("groups events with the same registrable domain into one bucket entry", () => {
    const corpus = aggregateTriageEvents(
      [
        ev({
          __typename: "BlocklistHttp",
          origAddr: "10.0.0.1",
          host: "a.example.com",
          category: "DISCOVERY", // score 0
          time: "2026-05-09T11:00:00.000Z",
        }),
        ev({
          __typename: "BlocklistHttp",
          origAddr: "10.0.0.2",
          host: "b.example.com",
          category: "EXFILTRATION", // score 1
          time: "2026-05-09T12:00:00.000Z",
        }),
        ev({
          __typename: "HttpThreat",
          origAddr: "10.0.0.3",
          host: "c.example.com",
          category: "INITIAL_ACCESS",
          clusterId: "", // HttpThreat cluster bonus → 1.5
          time: "2026-05-09T10:00:00.000Z",
        }),
      ],
      false,
    );
    const index = buildPivotIndex(corpus.events);
    const domainBucket = index.byDimension.get("registrableDomain");
    expect(domainBucket?.size).toBe(1);
    const entry = domainBucket?.get("example.com");
    expect(entry?.events).toHaveLength(3);
    expect(entry?.events.map((e) => e.score)).toEqual([1.5, 1, 0]);
  });

  it("orders shared-value events by score desc, ties broken newest-first", () => {
    const corpus = aggregateTriageEvents(
      [
        ev({
          __typename: "BlocklistHttp",
          origAddr: "10.0.0.1",
          host: "shared.example.com",
          category: "EXFILTRATION",
          time: "2026-05-09T10:00:00.000Z",
        }),
        ev({
          __typename: "BlocklistHttp",
          origAddr: "10.0.0.2",
          host: "shared.example.com",
          category: "EXFILTRATION",
          time: "2026-05-09T12:00:00.000Z",
        }),
        ev({
          __typename: "HttpThreat",
          origAddr: "10.0.0.3",
          host: "shared.example.com",
          category: "INITIAL_ACCESS",
          clusterId: "",
          time: "2026-05-09T08:00:00.000Z",
        }),
      ],
      false,
    );
    const index = buildPivotIndex(corpus.events);
    const entry = index.byDimension
      .get("registrableDomain")
      ?.get("example.com");
    expect(entry).toBeDefined();
    expect(entry?.events.map((e) => e.score)).toEqual([1.5, 1, 1]);
    // The two score-1 events sort newest-first.
    expect(entry?.events.slice(1).map((e) => e.time)).toEqual([
      "2026-05-09T12:00:00.000Z",
      "2026-05-09T10:00:00.000Z",
    ]);
  });
});

describe("buildPivotPanel", () => {
  it("hides dimensions where the focus carries no value", () => {
    const corpus = aggregateTriageEvents(
      [
        ev({
          __typename: "NetworkThreat",
          origAddr: "10.0.0.1",
          // No HTTP/TLS/DNS fields → those dimensions should be hidden.
          category: "EXFILTRATION",
        }),
      ],
      false,
    );
    const index = pivotIndexFor(corpus.events);
    const sections = buildPivotPanel(index, corpus.events);
    const ids = sections.map((s) => s.dimension);
    expect(ids).not.toContain("ja3");
    expect(ids).not.toContain("registrableDomain");
    expect(ids).not.toContain("dnsQuery");
  });

  it("hides dimensions where only the focus events match (zero pivot-interesting events)", () => {
    const focus = aggregateTriageEvents(
      [
        ev({
          origAddr: "10.0.0.1",
          host: "lonely.example.com",
          category: "EXFILTRATION",
        }),
      ],
      false,
    );
    const index = pivotIndexFor(focus.events);
    const sections = buildPivotPanel(index, focus.events);
    expect(
      sections.find((s) => s.dimension === "registrableDomain"),
    ).toBeUndefined();
  });

  it("caps each section's events array at PIVOT_GROUP_EXPANDED_ROWS", () => {
    const events: TriageEvent[] = [
      // Focus event
      ev({
        origAddr: "10.0.0.1",
        host: "a.example.com",
        category: "EXFILTRATION",
        time: "2026-05-09T12:00:00.000Z",
      }),
      // 100 other events sharing the same registrable domain
      ...Array.from({ length: 100 }, (_, i) =>
        ev({
          origAddr: `10.0.${1 + Math.floor(i / 100)}.${i + 2}`,
          host: `peer-${i}.example.com`,
          category: "EXFILTRATION",
          time: `2026-05-09T13:${String(i % 60).padStart(2, "0")}:00.000Z`,
        }),
      ),
    ];
    const corpus = aggregateTriageEvents(events, false);
    const focusEvents = corpus.events.slice(0, 1);
    const index = pivotIndexFor(corpus.events);
    const sections = buildPivotPanel(index, focusEvents);
    const domainSection = sections.find(
      (s) => s.dimension === "registrableDomain",
    );
    expect(domainSection).toBeDefined();
    expect(domainSection?.events.length).toBe(PIVOT_GROUP_EXPANDED_ROWS);
    expect(domainSection?.totalCount).toBe(100);
    expect(PIVOT_GROUP_EXPANDED_ROWS).toBeGreaterThan(PIVOT_GROUP_DEFAULT_ROWS);
  });

  it("excludes the focus events themselves from the related-events rows", () => {
    const events: TriageEvent[] = [
      ev({
        origAddr: "10.0.0.1",
        host: "a.example.com",
        category: "EXFILTRATION",
      }),
      ev({
        origAddr: "10.0.0.2",
        host: "b.example.com",
        category: "EXFILTRATION",
      }),
    ];
    const corpus = aggregateTriageEvents(events, false);
    const focus = corpus.events.slice(0, 1);
    const index = pivotIndexFor(corpus.events);
    const sections = buildPivotPanel(index, focus);
    const section = sections.find((s) => s.dimension === "registrableDomain");
    expect(section?.events.every((ev) => !focus.includes(ev))).toBe(true);
  });
});
