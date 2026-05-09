import { describe, expect, it } from "vitest";

import {
  baselineScore,
  passesBaseline,
  TRIAGE_BASELINE_WHITELIST,
  type TriageEvent,
} from "@/lib/triage";

function event(overrides: Partial<TriageEvent>): TriageEvent {
  return {
    __typename: "PortScan",
    time: "2026-05-09T12:00:00.000Z",
    sensor: "sensor-a",
    category: "RECONNAISSANCE",
    level: "MEDIUM",
    ...overrides,
  };
}

describe("baselineScore", () => {
  it("scores 0 for events outside the whitelist", () => {
    const e = event({ category: "RECONNAISSANCE" });
    expect(baselineScore(e)).toBe(0);
    expect(passesBaseline(e)).toBe(false);
  });

  it("scores 0 for events with a null category", () => {
    const e = event({ category: null });
    expect(baselineScore(e)).toBe(0);
  });

  it.each([
    ...TRIAGE_BASELINE_WHITELIST,
  ])("scores 1 for whitelisted category %s", (category) => {
    const e = event({ category });
    expect(baselineScore(e)).toBe(1);
    expect(passesBaseline(e)).toBe(true);
  });

  it("adds 0.5 for HttpThreat with empty clusterId", () => {
    const e = event({
      __typename: "HttpThreat",
      category: "COMMAND_AND_CONTROL",
      clusterId: "",
    });
    expect(baselineScore(e)).toBe(1.5);
  });

  it.each([
    "none",
    "NONE",
    "null",
    " null ",
  ])("treats clusterId %s as the no-cluster sentinel", (clusterId) => {
    const e = event({
      __typename: "HttpThreat",
      category: "EXFILTRATION",
      clusterId,
    });
    expect(baselineScore(e)).toBe(1.5);
  });

  it("does not apply the bonus for non-HttpThreat events", () => {
    const e = event({
      __typename: "NetworkThreat",
      category: "IMPACT",
      clusterId: "",
    });
    expect(baselineScore(e)).toBe(1);
  });

  it("does not apply the bonus when clusterId is a real value", () => {
    const e = event({
      __typename: "HttpThreat",
      category: "INITIAL_ACCESS",
      clusterId: "cluster-42",
    });
    expect(baselineScore(e)).toBe(1);
  });
});
