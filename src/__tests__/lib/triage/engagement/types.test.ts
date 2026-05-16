import { describe, expect, it } from "vitest";

import {
  ENGAGEMENT_JOIN_ID_DIMENSIONS,
  pivotValuePayload,
} from "@/lib/triage/engagement/types";

// #588 R4: the client emit must choose `pivotValueJoinId` for
// natural-join dimensions and `pivotValue` for raw-ish dimensions. Pre-
// fix the three emit sites in `baseline-content.tsx` posted
// `pivotValue` unconditionally, so a `sameSensor` / `learningMethods`
// click landed HMAC-only even though the issue calls for the natural
// id to go straight into `engagement_action.pivot_value_join_id`.
describe("pivotValuePayload", () => {
  it("routes natural-join dimensions through pivotValueJoinId", () => {
    for (const dim of ENGAGEMENT_JOIN_ID_DIMENSIONS) {
      const payload = pivotValuePayload(dim, "value-key");
      expect(payload).toEqual({ pivotValueJoinId: "value-key" });
      expect(payload).not.toHaveProperty("pivotValue");
    }
  });

  it("routes sameSensor and learningMethods through pivotValueJoinId (the specific Round 4 cases)", () => {
    expect(pivotValuePayload("sameSensor", "sensor-7")).toEqual({
      pivotValueJoinId: "sensor-7",
    });
    expect(pivotValuePayload("learningMethods", "supervised")).toEqual({
      pivotValueJoinId: "supervised",
    });
  });

  it("routes raw-ish dimensions (IP / domain / SNI / JA3 / country) through pivotValue", () => {
    for (const dim of [
      "externalIp",
      "internalIp",
      "host",
      "registrableDomain",
      "sni",
      "ja3",
      "ja3s",
      "country",
      "dnsQuery",
      "dnsAnswer",
      "uriPattern",
      "userAgent",
    ]) {
      const payload = pivotValuePayload(dim, "raw-value");
      expect(payload).toEqual({ pivotValue: "raw-value" });
      expect(payload).not.toHaveProperty("pivotValueJoinId");
    }
  });

  it("routes unknown dimensions through pivotValue (safe default — server HMACs)", () => {
    const payload = pivotValuePayload("brandNewDimensionId", "raw-value");
    expect(payload).toEqual({ pivotValue: "raw-value" });
  });
});
