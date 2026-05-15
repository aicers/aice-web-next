import { describe, expect, it } from "vitest";

import {
  cutoffForStop,
  DEFAULT_STRICTNESS_STOP_ID,
  getStrictnessStop,
  parseStrictnessStopId,
  STRICTNESS_STOPS,
  type StrictnessStopId,
} from "@/lib/triage/strictness/stops";

describe("STRICTNESS_STOPS", () => {
  it("exposes five stops ordered loose -> strict", () => {
    const ids = STRICTNESS_STOPS.map((s) => s.id);
    expect(ids).toEqual(["all", "top80", "top50", "top20", "top5"]);
  });

  it("cutoffs follow cume_dist identity 1 - X/100", () => {
    const byId = new Map(STRICTNESS_STOPS.map((s) => [s.id, s]));
    expect(byId.get("all")?.cutoff).toBe(0);
    expect(byId.get("top80")?.cutoff).toBeCloseTo(0.2);
    expect(byId.get("top50")?.cutoff).toBeCloseTo(0.5);
    expect(byId.get("top20")?.cutoff).toBeCloseTo(0.8);
    expect(byId.get("top5")?.cutoff).toBeCloseTo(0.95);
  });

  it("middle stop is the default", () => {
    expect(DEFAULT_STRICTNESS_STOP_ID).toBe("top50");
  });
});

describe("parseStrictnessStopId", () => {
  it("returns the default for null / undefined / empty", () => {
    expect(parseStrictnessStopId(null)).toBe(DEFAULT_STRICTNESS_STOP_ID);
    expect(parseStrictnessStopId(undefined)).toBe(DEFAULT_STRICTNESS_STOP_ID);
  });

  it("returns the default for unknown ids — no error on stale persisted state", () => {
    expect(parseStrictnessStopId("topInvalid")).toBe(
      DEFAULT_STRICTNESS_STOP_ID,
    );
    expect(parseStrictnessStopId("0.95")).toBe(DEFAULT_STRICTNESS_STOP_ID);
  });

  it("round-trips known ids", () => {
    for (const stop of STRICTNESS_STOPS) {
      expect(parseStrictnessStopId(stop.id)).toBe(stop.id);
    }
  });
});

describe("getStrictnessStop / cutoffForStop", () => {
  it("resolves cutoff by id", () => {
    expect(cutoffForStop("all")).toBe(0);
    expect(cutoffForStop("top5")).toBeCloseTo(0.95);
  });

  it("getStrictnessStop returns the matching record", () => {
    const stop = getStrictnessStop("top20" as StrictnessStopId);
    expect(stop.id).toBe("top20");
    expect(stop.cutoff).toBeCloseTo(0.8);
  });
});
