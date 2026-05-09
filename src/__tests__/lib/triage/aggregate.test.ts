import { describe, expect, it } from "vitest";

import { aggregateTriageEvents, type TriageEvent } from "@/lib/triage";

function ev(overrides: Partial<TriageEvent>): TriageEvent {
  return {
    __typename: "NetworkThreat",
    time: "2026-05-09T12:00:00.000Z",
    sensor: "sensor-a",
    category: "RECONNAISSANCE",
    level: "MEDIUM",
    origAddr: "10.0.0.1",
    ...overrides,
  };
}

describe("aggregateTriageEvents", () => {
  it("returns an empty payload for an empty event list", () => {
    const result = aggregateTriageEvents([], false);
    expect(result.funnel).toEqual({
      detected: 0,
      triaged: 0,
      passThroughRate: 0,
    });
    expect(result.assets).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.loadedEventCount).toBe(0);
  });

  it("computes funnel stats and pass-through rate", () => {
    const events: TriageEvent[] = [
      ev({ category: "COMMAND_AND_CONTROL" }),
      ev({ category: "EXFILTRATION" }),
      ev({ category: "DISCOVERY" }),
      ev({ category: null }),
    ];
    const result = aggregateTriageEvents(events, false);
    expect(result.funnel.detected).toBe(4);
    expect(result.funnel.triaged).toBe(2);
    expect(result.funnel.passThroughRate).toBeCloseTo(0.5);
  });

  it("groups assets by originator address and sorts by score", () => {
    const events: TriageEvent[] = [
      ev({ origAddr: "10.0.0.1", category: "COMMAND_AND_CONTROL" }),
      ev({ origAddr: "10.0.0.1", category: "IMPACT" }),
      ev({
        __typename: "HttpThreat",
        origAddr: "10.0.0.2",
        category: "INITIAL_ACCESS",
        clusterId: "",
      }),
      ev({ origAddr: "10.0.0.3", category: "RECONNAISSANCE" }),
    ];
    const result = aggregateTriageEvents(events, false);
    // 10.0.0.3 only emits non-triaged events, so it must not appear
    // in the asset list — that empty-asset case is what powers the
    // "No assets matched the baseline rule" empty state.
    expect(result.assets.map((a) => a.address)).toEqual([
      "10.0.0.1",
      "10.0.0.2",
    ]);
    expect(result.assets[0].score).toBe(2);
    expect(result.assets[1].score).toBe(1.5);
  });

  it("omits assets whose events all fail the baseline rule", () => {
    const events: TriageEvent[] = [
      ev({ origAddr: "10.0.0.1", category: "RECONNAISSANCE" }),
      ev({ origAddr: "10.0.0.2", category: "DISCOVERY" }),
      ev({ origAddr: "10.0.0.2", category: null }),
    ];
    const result = aggregateTriageEvents(events, false);
    expect(result.funnel.detected).toBe(3);
    expect(result.funnel.triaged).toBe(0);
    expect(result.assets).toEqual([]);
  });

  it("propagates the truncated flag into the result", () => {
    const result = aggregateTriageEvents([], true);
    expect(result.truncated).toBe(true);
  });

  it("counts every event toward the asset's detectedCount", () => {
    const events: TriageEvent[] = [
      ev({ origAddr: "10.0.0.1", category: "DISCOVERY" }),
      ev({ origAddr: "10.0.0.1", category: "COMMAND_AND_CONTROL" }),
    ];
    const result = aggregateTriageEvents(events, false);
    expect(result.assets[0].detectedCount).toBe(2);
    expect(result.assets[0].triagedCount).toBe(1);
  });

  it("ignores events that have no usable origAddr for grouping", () => {
    const events: TriageEvent[] = [
      ev({ origAddr: undefined, category: "EXFILTRATION" }),
      ev({ origAddr: "10.0.0.1", category: "EXFILTRATION" }),
    ];
    const result = aggregateTriageEvents(events, false);
    expect(result.funnel.triaged).toBe(2);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].address).toBe("10.0.0.1");
  });

  it("orders the asset's events newest-first", () => {
    const events: TriageEvent[] = [
      ev({
        origAddr: "10.0.0.1",
        category: "EXFILTRATION",
        time: "2026-05-09T10:00:00.000Z",
      }),
      ev({
        origAddr: "10.0.0.1",
        category: "EXFILTRATION",
        time: "2026-05-09T12:00:00.000Z",
      }),
      ev({
        origAddr: "10.0.0.1",
        category: "EXFILTRATION",
        time: "2026-05-09T11:00:00.000Z",
      }),
    ];
    const result = aggregateTriageEvents(events, false);
    expect(result.assets[0].events.map((e) => e.time)).toEqual([
      "2026-05-09T12:00:00.000Z",
      "2026-05-09T11:00:00.000Z",
      "2026-05-09T10:00:00.000Z",
    ]);
  });
});
