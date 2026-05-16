import { describe, expect, it } from "vitest";

import {
  EngagementValidationError,
  parseAction,
  parseImpressionBatch,
} from "@/lib/triage/engagement/parse";

const VALID_UUID = "00000000-0000-4000-8000-000000000000";

function baseImpression() {
  return {
    eventKey: "evt-1",
    kind: "HttpThreat",
    slotBucket: "HttpThreat:false",
    rank: 1,
    baselineVersion: "phase1b-four-selector",
    shownBy: "quota",
  };
}

function baseBatch() {
  return {
    kind: "impressions",
    customerId: 1,
    menuLoadId: VALID_UUID,
    strictnessStop: "top50",
    surface: "baseline",
    periodStartIso: "2026-05-09T00:00:00.000Z",
    periodEndIso: "2026-05-16T00:00:00.000Z",
    impressions: [baseImpression()],
  };
}

describe("parseImpressionBatch", () => {
  it("accepts a well-formed batch", () => {
    const batch = parseImpressionBatch(baseBatch());
    expect(batch.menuLoadId).toBe(VALID_UUID);
    expect(batch.impressions).toHaveLength(1);
    expect(batch.impressions[0].shownBy).toBe("quota");
  });

  it("rejects a missing kind", () => {
    expect(() =>
      parseImpressionBatch({ ...baseBatch(), kind: "wrong" }),
    ).toThrow(EngagementValidationError);
  });

  it("rejects a non-UUID menuLoadId", () => {
    expect(() =>
      parseImpressionBatch({ ...baseBatch(), menuLoadId: "not-a-uuid" }),
    ).toThrow(/menuLoadId/);
  });

  it("rejects a rank ≤ 0", () => {
    expect(() =>
      parseImpressionBatch({
        ...baseBatch(),
        impressions: [{ ...baseImpression(), rank: 0 }],
      }),
    ).toThrow(/rank/);
  });

  it("rejects an unknown shownBy", () => {
    expect(() =>
      parseImpressionBatch({
        ...baseBatch(),
        impressions: [{ ...baseImpression(), shownBy: "strictness" }],
      }),
    ).toThrow(/shownBy/);
  });

  it("maps an unknown strictnessStop to the default", () => {
    const batch = parseImpressionBatch({
      ...baseBatch(),
      strictnessStop: "nonsense",
    });
    expect(batch.strictnessStop).toBe("top50");
  });

  it("rejects a batch over the per-call cap", () => {
    const big = Array.from({ length: 10_001 }, (_, i) => ({
      ...baseImpression(),
      eventKey: `evt-${i}`,
      rank: i + 1,
    }));
    expect(() =>
      parseImpressionBatch({ ...baseBatch(), impressions: big }),
    ).toThrow(/exceed batch cap/);
  });
});

describe("parseAction", () => {
  it("accepts a well-formed asset_select", () => {
    const action = parseAction({
      kind: "action",
      action: {
        type: "asset_select",
        customerId: 7,
        surface: "baseline",
        assetAddress: "10.0.0.1",
      },
    });
    expect(action.type).toBe("asset_select");
    if (action.type === "asset_select") {
      expect(action.assetAddress).toBe("10.0.0.1");
    }
  });

  it("accepts a pivot_click with pivotValue", () => {
    const action = parseAction({
      kind: "action",
      action: {
        type: "pivot_click",
        customerId: 7,
        surface: "baseline",
        eventKey: "evt-1",
        kind: "HttpThreat",
        baselineVersion: "phase1b-four-selector",
        dimension: "host",
        pivotValue: "example.com",
      },
    });
    expect(action.type).toBe("pivot_click");
  });

  it("rejects a pivot_click that omits both pivotValue and pivotValueJoinId", () => {
    expect(() =>
      parseAction({
        kind: "action",
        action: {
          type: "pivot_click",
          customerId: 7,
          surface: "baseline",
          eventKey: "evt-1",
          kind: "HttpThreat",
          baselineVersion: "phase1b-four-selector",
          dimension: "host",
        },
      }),
    ).toThrow(/Exactly one of/);
  });

  it("rejects a pivot_click that sets both pivotValue and pivotValueJoinId", () => {
    expect(() =>
      parseAction({
        kind: "action",
        action: {
          type: "pivot_click",
          customerId: 7,
          surface: "baseline",
          eventKey: "evt-1",
          kind: "HttpThreat",
          baselineVersion: "phase1b-four-selector",
          dimension: "host",
          pivotValue: "example.com",
          pivotValueJoinId: "id-1",
        },
      }),
    ).toThrow(/Exactly one of/);
  });

  it("accepts a story_pivot_click with a join-id dimension", () => {
    const action = parseAction({
      kind: "action",
      action: {
        type: "story_pivot_click",
        customerId: 7,
        surface: "baseline",
        eventKey: "evt-1",
        kind: "HttpThreat",
        baselineVersion: "phase1b-four-selector",
        storyId: "story-1",
        dimension: "sameSensor",
        pivotValueJoinId: "sensor-7",
      },
    });
    expect(action.type).toBe("story_pivot_click");
  });

  // #588 R3 item 1: raw-ish dimensions (sni / externalIp / …) MUST go
  // through the HMAC path. A buggy or stale client posting a raw value
  // as `pivotValueJoinId` must be rejected at the parser before it can
  // land in `engagement_action.pivot_value_join_id` and bypass the
  // pseudonymizer.
  it("rejects a pivot_click that posts pivotValueJoinId for a raw-ish dimension (sni)", () => {
    expect(() =>
      parseAction({
        kind: "action",
        action: {
          type: "pivot_click",
          customerId: 7,
          surface: "baseline",
          eventKey: "evt-1",
          kind: "HttpThreat",
          baselineVersion: "phase1b-four-selector",
          dimension: "sni",
          pivotValueJoinId: "Example.COM",
        },
      }),
    ).toThrow(/raw-ish/);
  });

  it("rejects a pivot_click that posts pivotValueJoinId for externalIp", () => {
    expect(() =>
      parseAction({
        kind: "action",
        action: {
          type: "pivot_click",
          customerId: 7,
          surface: "baseline",
          eventKey: "evt-1",
          kind: "HttpThreat",
          baselineVersion: "phase1b-four-selector",
          dimension: "externalIp",
          pivotValueJoinId: "010.000.000.001",
        },
      }),
    ).toThrow(/raw-ish/);
  });

  it("rejects a story_pivot_click that posts pivotValueJoinId for a raw-ish dimension (host)", () => {
    expect(() =>
      parseAction({
        kind: "action",
        action: {
          type: "story_pivot_click",
          customerId: 7,
          surface: "baseline",
          eventKey: "evt-1",
          kind: "HttpThreat",
          baselineVersion: "phase1b-four-selector",
          storyId: "story-1",
          dimension: "host",
          pivotValueJoinId: "example.com",
        },
      }),
    ).toThrow(/raw-ish/);
  });

  // #588 R5 item 1: the inverse — a natural-join dimension MUST use
  // `pivotValueJoinId`. A stale client posting `pivotValue` for an
  // allowlisted dimension is rejected so the row is not silently
  // HMAC'd and persisted as pivot_value_hmac (Phase 2 reads
  // `pivot_value_join_id` for these dimensions and would lose the
  // signal).
  it("rejects a pivot_click that posts pivotValue for a natural-join dimension (sameSensor)", () => {
    expect(() =>
      parseAction({
        kind: "action",
        action: {
          type: "pivot_click",
          customerId: 7,
          surface: "baseline",
          eventKey: "evt-1",
          kind: "HttpThreat",
          baselineVersion: "phase1b-four-selector",
          dimension: "sameSensor",
          pivotValue: "sensor-alpha",
        },
      }),
    ).toThrow(/natural-join/);
  });

  it("rejects a story_pivot_click that posts pivotValue for a natural-join dimension (kinds)", () => {
    expect(() =>
      parseAction({
        kind: "action",
        action: {
          type: "story_pivot_click",
          customerId: 7,
          surface: "baseline",
          eventKey: "evt-1",
          kind: "HttpThreat",
          baselineVersion: "phase1b-four-selector",
          storyId: "story-1",
          dimension: "kinds",
          pivotValue: "HttpThreat",
        },
      }),
    ).toThrow(/natural-join/);
  });

  it("accepts a strictness_change", () => {
    const action = parseAction({
      kind: "action",
      action: {
        type: "strictness_change",
        customerId: 7,
        surface: "baseline",
        strictnessFrom: "top50",
        strictnessTo: "top20",
      },
    });
    expect(action.type).toBe("strictness_change");
    if (action.type === "strictness_change") {
      expect(action.strictnessFrom).toBe("top50");
      expect(action.strictnessTo).toBe("top20");
    }
  });

  it("rejects exclusion_create via the HTTP endpoint", () => {
    expect(() =>
      parseAction({
        kind: "action",
        action: {
          type: "exclusion_create",
          customerId: 7,
          surface: "baseline",
          exclusionId: "id-1",
        },
      }),
    ).toThrow(/recorded server-side/);
  });

  it("rejects an unknown action type", () => {
    expect(() =>
      parseAction({
        kind: "action",
        action: {
          type: "made_up",
          customerId: 7,
          surface: "baseline",
        },
      }),
    ).toThrow(/Unknown action type/);
  });
});
