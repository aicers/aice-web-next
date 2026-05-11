import { describe, expect, it } from "vitest";

import { aggregateTriageEvents, type TriageEvent } from "@/lib/triage";
import {
  appendPivotStep,
  backtrackPivotTrail,
  clearPivotTrail,
  hasPivotedAwayFromAsset,
  type PivotStep,
  pivotIndexFor,
  resolveStepFocusEvents,
} from "@/lib/triage/pivot";

let evSeq = 0;
function ev(overrides: Partial<TriageEvent>): TriageEvent {
  evSeq += 1;
  return {
    __typename: "BlocklistTls",
    id: `evt-${evSeq}`,
    time: "2026-05-09T12:00:00.000Z",
    sensor: "sensor-a",
    category: "EXFILTRATION",
    level: "MEDIUM",
    ...overrides,
  };
}

const ASSET_STEP: PivotStep = { kind: "asset", address: "10.0.0.1" };
const JA3_STEP: PivotStep = {
  kind: "dimension",
  dimension: "ja3",
  value: { key: "abc", label: "abc" },
};
const SNI_STEP: PivotStep = {
  kind: "dimension",
  dimension: "sni",
  value: { key: "example.com", label: "example.com" },
};

describe("appendPivotStep", () => {
  it("appends a new step", () => {
    expect(appendPivotStep([ASSET_STEP], JA3_STEP)).toEqual([
      ASSET_STEP,
      JA3_STEP,
    ]);
  });

  it("does not duplicate the same dimension+value if appended twice in a row", () => {
    const trail = appendPivotStep([ASSET_STEP], JA3_STEP);
    expect(appendPivotStep(trail, JA3_STEP)).toEqual(trail);
  });
});

describe("backtrackPivotTrail", () => {
  it("truncates to the inclusive index", () => {
    const trail = [ASSET_STEP, JA3_STEP, SNI_STEP];
    expect(backtrackPivotTrail(trail, 0)).toEqual([ASSET_STEP]);
    expect(backtrackPivotTrail(trail, 1)).toEqual([ASSET_STEP, JA3_STEP]);
    expect(backtrackPivotTrail(trail, 2)).toEqual(trail);
  });

  it("returns [] for a negative index", () => {
    expect(backtrackPivotTrail([ASSET_STEP, JA3_STEP], -1)).toEqual([]);
  });
});

describe("clearPivotTrail", () => {
  it("keeps only the asset root", () => {
    expect(clearPivotTrail([ASSET_STEP, JA3_STEP, SNI_STEP])).toEqual([
      ASSET_STEP,
    ]);
  });

  it("returns [] when the trail is empty", () => {
    expect(clearPivotTrail([])).toEqual([]);
  });

  it("returns [] when the trail starts with a dimension step (no asset root)", () => {
    expect(clearPivotTrail([JA3_STEP, SNI_STEP])).toEqual([]);
  });
});

describe("hasPivotedAwayFromAsset", () => {
  it("is false when the trail is empty or asset-only", () => {
    expect(hasPivotedAwayFromAsset([])).toBe(false);
    expect(hasPivotedAwayFromAsset([ASSET_STEP])).toBe(false);
  });

  it("is true once any dimension step is appended", () => {
    expect(hasPivotedAwayFromAsset([ASSET_STEP, JA3_STEP])).toBe(true);
  });
});

describe("resolveStepFocusEvents", () => {
  const corpus = aggregateTriageEvents(
    [
      ev({
        origAddr: "10.0.0.1",
        ja3: "abc",
        category: "EXFILTRATION",
        time: "2026-05-09T12:00:00.000Z",
      }),
      ev({
        origAddr: "10.0.0.1",
        ja3: "abc",
        category: "DISCOVERY",
        time: "2026-05-09T11:00:00.000Z",
      }),
      ev({
        origAddr: "10.0.0.2",
        ja3: "abc",
        category: "EXFILTRATION",
        time: "2026-05-09T10:00:00.000Z",
      }),
    ],
    false,
  );
  const index = pivotIndexFor(corpus.events);

  it("resolves an asset step to events whose origAddr matches", () => {
    const events = resolveStepFocusEvents(ASSET_STEP, corpus.events, index);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.origAddr === "10.0.0.1")).toBe(true);
  });

  it("resolves a dimension step to events sharing that value", () => {
    const events = resolveStepFocusEvents(JA3_STEP, corpus.events, index);
    expect(events).toHaveLength(3);
  });
});
