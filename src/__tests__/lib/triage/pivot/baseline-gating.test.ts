import { describe, expect, it } from "vitest";

import {
  buildPivotIndex,
  buildPivotPanel,
  isDimensionAvailableInBaseline,
  PIVOT_DIMENSIONS,
  PIVOT_DIMENSIONS_BASELINE,
} from "@/lib/triage/pivot";
import type { ScoredTriageEvent } from "@/lib/triage/types";

const POLICY_ONLY_DIMS = new Set([
  "country",
  "userAgent",
  "ja3",
  "ja3s",
  "sni",
  "certSerial",
  "certSubjectCn",
  "dnsAnswer",
  "clusterId",
  "levels",
]);

describe("Baseline-mode pivot gating", () => {
  it("PIVOT_DIMENSIONS_BASELINE excludes every Policy-only dimension", () => {
    const ids = new Set(PIVOT_DIMENSIONS_BASELINE.map((d) => d.id));
    for (const d of POLICY_ONLY_DIMS) expect(ids.has(d as never)).toBe(false);
    // Sanity: the gating is meaningful (dropped ≥ 1 dimension).
    expect(PIVOT_DIMENSIONS_BASELINE.length).toBeLessThan(
      PIVOT_DIMENSIONS.length,
    );
  });

  it("isDimensionAvailableInBaseline returns false for Policy-only dimensions", () => {
    for (const dim of PIVOT_DIMENSIONS) {
      const expected = !POLICY_ONLY_DIMS.has(dim.id);
      expect(isDimensionAvailableInBaseline(dim)).toBe(expected);
    }
  });

  function policyEvent(): ScoredTriageEvent {
    return {
      __typename: "TlsBlocklist",
      id: "evt-policy",
      time: "2026-05-09T12:00:00.000Z",
      sensor: "sensor-a",
      category: "EXFILTRATION",
      level: "MEDIUM",
      origAddr: "10.0.0.1",
      respAddr: "8.8.8.8",
      origCountry: "KR",
      respCountry: "US",
      ja3: "abc",
      ja3S: "def",
      serverName: "example.com",
      userAgent: "curl",
      score: 1,
      customerId: 0,
    };
  }

  it("buildPivotIndex(mode='baseline') has no buckets for Policy-only dimensions", () => {
    const index = buildPivotIndex([policyEvent()], "baseline");
    for (const d of POLICY_ONLY_DIMS) {
      expect(index.byDimension.has(d as never)).toBe(false);
    }
    // Sanity: a baseline-available dim DOES get a bucket (always
    // pre-allocated at index time, regardless of whether any event
    // populates it).
    expect(index.byDimension.has("host")).toBe(true);
    expect(index.byDimension.has("port")).toBe(true);
  });

  it("buildPivotIndex(mode='policy') keeps the Policy-only buckets", () => {
    const index = buildPivotIndex([policyEvent()], "policy");
    expect(index.byDimension.has("ja3")).toBe(true);
    expect(index.byDimension.has("country")).toBe(true);
  });

  it("buildPivotPanel(mode='baseline') drops Policy-only sections", () => {
    const corpus: ScoredTriageEvent[] = [policyEvent(), policyEvent()];
    const index = buildPivotIndex(corpus, "baseline");
    const sections = buildPivotPanel(index, [corpus[0]], {
      mode: "baseline",
      excludeFocusEvents: false,
    });
    const ids = sections.map((s) => s.dimension);
    for (const d of POLICY_ONLY_DIMS) {
      expect(ids).not.toContain(d);
    }
  });
});
