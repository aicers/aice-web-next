import { describe, expect, it } from "vitest";

import { aggregateTriageEvents, type TriageEvent } from "@/lib/triage";

let evSeq = 0;
function ev(overrides: Partial<TriageEvent>): TriageEvent {
  evSeq += 1;
  return {
    __typename: "NetworkThreat",
    id: `evt-${evSeq}`,
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
    expect(result.events).toEqual([]);
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

  it("populates asset.events from baseline-passing events only", () => {
    const events: TriageEvent[] = [
      ev({
        origAddr: "10.0.0.1",
        category: "EXFILTRATION",
        time: "2026-05-09T08:00:00.000Z",
      }),
      ev({
        origAddr: "10.0.0.1",
        category: "RECONNAISSANCE",
        time: "2026-05-09T10:00:00.000Z",
      }),
      ev({
        origAddr: "10.0.0.1",
        category: "DISCOVERY",
        time: "2026-05-09T11:00:00.000Z",
      }),
    ];
    const result = aggregateTriageEvents(events, false);
    const [asset] = result.assets;
    expect(asset.detectedCount).toBe(3);
    expect(asset.triagedCount).toBe(1);
    expect(asset.events).toHaveLength(1);
    expect(asset.events[0].category).toBe("EXFILTRATION");
  });

  it("keeps the scored event visible even with many newer non-baseline events", () => {
    // Regression: previously asset.events held every event, so a
    // single old triaged event could be pushed past the 50-event
    // detail window by newer non-whitelisted noise. The detail panel
    // would then show a positive score row whose events were all
    // score-0, breaking explainability.
    const triagedEvent = ev({
      origAddr: "10.0.0.1",
      category: "EXFILTRATION",
      time: "2026-05-08T00:00:00.000Z",
    });
    const noise: TriageEvent[] = Array.from({ length: 60 }, (_, i) =>
      ev({
        origAddr: "10.0.0.1",
        category: "RECONNAISSANCE",
        time: `2026-05-09T${String(i % 24).padStart(2, "0")}:00:00.000Z`,
      }),
    );
    const result = aggregateTriageEvents([triagedEvent, ...noise], false);
    const [asset] = result.assets;
    expect(asset.score).toBeGreaterThan(0);
    expect(asset.events).toHaveLength(1);
    expect(asset.events[0].category).toBe("EXFILTRATION");
  });

  describe("scored events corpus", () => {
    it("attaches per-event score on the top-level events array", () => {
      const triaged = ev({
        origAddr: "10.0.0.1",
        category: "COMMAND_AND_CONTROL",
        time: "2026-05-09T10:00:00.000Z",
      });
      const httpClusterNone = ev({
        __typename: "HttpThreat",
        origAddr: "10.0.0.1",
        category: "INITIAL_ACCESS",
        clusterId: "",
        time: "2026-05-09T11:00:00.000Z",
      });
      const noise = ev({
        origAddr: "10.0.0.1",
        category: "DISCOVERY",
        time: "2026-05-09T12:00:00.000Z",
      });
      const result = aggregateTriageEvents(
        [triaged, httpClusterNone, noise],
        false,
      );
      expect(result.events).toHaveLength(3);
      const byTime = new Map(result.events.map((e) => [e.time, e.score]));
      expect(byTime.get("2026-05-09T10:00:00.000Z")).toBe(1);
      expect(byTime.get("2026-05-09T11:00:00.000Z")).toBe(1.5);
      expect(byTime.get("2026-05-09T12:00:00.000Z")).toBe(0);
    });

    it("attaches per-event score on assets[*].events", () => {
      const events: TriageEvent[] = [
        ev({ origAddr: "10.0.0.1", category: "EXFILTRATION" }),
        ev({
          __typename: "HttpThreat",
          origAddr: "10.0.0.1",
          category: "INITIAL_ACCESS",
          clusterId: "none",
        }),
      ];
      const result = aggregateTriageEvents(events, false);
      const [asset] = result.assets;
      expect(asset.events).toHaveLength(2);
      const scores = asset.events.map((e) => e.score).sort();
      expect(scores).toEqual([1, 1.5]);
    });

    it("the top-level events length equals loadedEventCount", () => {
      const events: TriageEvent[] = Array.from({ length: 17 }, (_, i) =>
        ev({
          origAddr: i % 2 === 0 ? "10.0.0.1" : undefined,
          category: i % 3 === 0 ? "EXFILTRATION" : "RECONNAISSANCE",
          time: `2026-05-09T${String(i % 24).padStart(2, "0")}:00:00.000Z`,
        }),
      );
      const result = aggregateTriageEvents(events, false);
      expect(result.events).toHaveLength(result.loadedEventCount);
      expect(result.events).toHaveLength(17);
    });

    it("includes non-baseline events in the top-level corpus with score 0", () => {
      // #452 builds its pivot index over the full corpus and filters
      // to triaged events at index time, so non-baseline events MUST
      // be present in `events` (with score 0) even though they are
      // absent from the per-asset detail list.
      const events: TriageEvent[] = [
        ev({ origAddr: "10.0.0.1", category: "RECONNAISSANCE" }),
        ev({ origAddr: "10.0.0.2", category: "EXFILTRATION" }),
      ];
      const result = aggregateTriageEvents(events, false);
      expect(result.events).toHaveLength(2);
      const recon = result.events.find((e) => e.category === "RECONNAISSANCE");
      const exfil = result.events.find((e) => e.category === "EXFILTRATION");
      expect(recon?.score).toBe(0);
      expect(exfil?.score).toBe(1);
    });

    it("keeps the 50-cap on assets[*].events while events corpus is uncapped", () => {
      // Generate 60 baseline-passing events for one asset. The asset
      // detail list must stay capped at 50, but the top-level scored
      // corpus must contain all 60 so #452 can pivot over the full
      // loaded slice.
      const events: TriageEvent[] = Array.from({ length: 60 }, (_, i) => {
        const hour = String(i % 24).padStart(2, "0");
        const minute = String(Math.floor(i / 24)).padStart(2, "0");
        return ev({
          origAddr: "10.0.0.1",
          category: "EXFILTRATION",
          time: `2026-05-09T${hour}:${minute}:00.000Z`,
        });
      });
      const result = aggregateTriageEvents(events, false);
      expect(result.events).toHaveLength(60);
      expect(result.assets[0].events).toHaveLength(50);
    });
  });
});
