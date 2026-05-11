import { describe, expect, it } from "vitest";

import {
  baselineScore,
  hasUnlabeledBonus,
  PHASE_1A_CLUSTER_NONE_BONUS,
  PHASE_1A_WHITELIST_SCORE,
  passesBaseline,
  TRIAGE_BASELINE_WHITELIST,
  type TriageEvent,
} from "@/lib/triage";

let evSeq = 0;
function event(overrides: Partial<TriageEvent>): TriageEvent {
  evSeq += 1;
  return {
    __typename: "PortScan",
    id: `evt-${evSeq}`,
    time: "2026-05-09T12:00:00.000Z",
    sensor: "sensor-a",
    category: "RECONNAISSANCE",
    level: "MEDIUM",
    ...overrides,
  };
}

describe("baselineScore — additive formula", () => {
  it("scores 0 for events outside the whitelist with no cluster bonus", () => {
    const e = event({ category: "RECONNAISSANCE" });
    expect(baselineScore(e)).toBe(0);
    expect(passesBaseline(e)).toBe(false);
  });

  it("scores 0 for events with a null category and no cluster bonus", () => {
    const e = event({ category: null });
    expect(baselineScore(e)).toBe(0);
  });

  it.each([
    ...TRIAGE_BASELINE_WHITELIST,
  ])("scores 1.0 for whitelisted category %s (labeled cluster, non-HttpThreat)", (category) => {
    const e = event({ category });
    expect(baselineScore(e)).toBe(PHASE_1A_WHITELIST_SCORE);
    expect(passesBaseline(e)).toBe(true);
  });

  it("scores 1.5 for whitelisted HttpThreat with empty clusterId", () => {
    const e = event({
      __typename: "HttpThreat",
      category: "COMMAND_AND_CONTROL",
      clusterId: "",
    });
    expect(baselineScore(e)).toBe(
      PHASE_1A_WHITELIST_SCORE + PHASE_1A_CLUSTER_NONE_BONUS,
    );
    expect(hasUnlabeledBonus(e)).toBe(true);
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

  it("does not apply the bonus for non-HttpThreat events even when clusterId is empty", () => {
    const e = event({
      __typename: "NetworkThreat",
      category: "IMPACT",
      clusterId: "",
    });
    expect(baselineScore(e)).toBe(1);
    expect(hasUnlabeledBonus(e)).toBe(false);
  });

  it("does not apply the bonus when HttpThreat clusterId is a real value", () => {
    const e = event({
      __typename: "HttpThreat",
      category: "INITIAL_ACCESS",
      clusterId: "cluster-42",
    });
    expect(baselineScore(e)).toBe(1);
    expect(hasUnlabeledBonus(e)).toBe(false);
  });

  it("scores 0.5 (unlabeled-only path) for HttpThreat with non-whitelisted category and no cluster", () => {
    const e = event({
      __typename: "HttpThreat",
      category: "RECONNAISSANCE",
      clusterId: "",
    });
    expect(baselineScore(e)).toBe(PHASE_1A_CLUSTER_NONE_BONUS);
    expect(passesBaseline(e)).toBe(true);
    expect(hasUnlabeledBonus(e)).toBe(true);
  });

  it("scores 0.5 for HttpThreat with null category and a no-cluster sentinel", () => {
    const e = event({
      __typename: "HttpThreat",
      category: null,
      clusterId: "none",
    });
    expect(baselineScore(e)).toBe(0.5);
    expect(passesBaseline(e)).toBe(true);
  });

  it("baselineScore is the additive sum of the three pass-paths", () => {
    // Pass-path A: whitelisted, labeled cluster.
    expect(
      baselineScore(event({ category: "IMPACT", __typename: "NetworkThreat" })),
    ).toBe(1.0);
    // Pass-path B: unlabeled HttpThreat, non-whitelisted.
    expect(
      baselineScore(
        event({
          category: "RECONNAISSANCE",
          __typename: "HttpThreat",
          clusterId: " null ",
        }),
      ),
    ).toBe(0.5);
    // Pass-path C: whitelisted, unlabeled HttpThreat.
    expect(
      baselineScore(
        event({
          category: "CREDENTIAL_ACCESS",
          __typename: "HttpThreat",
          clusterId: "none",
        }),
      ),
    ).toBe(1.5);
  });
});
