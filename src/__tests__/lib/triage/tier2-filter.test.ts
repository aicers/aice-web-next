import { describe, expect, it } from "vitest";

import {
  buildTier2Filter,
  isTier2ServerDimension,
} from "@/lib/triage/tier2-filter";

const PERIOD = {
  startIso: "2026-05-08T12:00:00.000Z",
  endIso: "2026-05-09T12:00:00.000Z",
};

describe("isTier2ServerDimension", () => {
  it("accepts only the Tier 2 server-filtered dimensions", () => {
    expect(isTier2ServerDimension("kinds")).toBe(true);
    expect(isTier2ServerDimension("categories")).toBe(true);
    expect(isTier2ServerDimension("levels")).toBe(true);
    expect(isTier2ServerDimension("learningMethods")).toBe(true);
    expect(isTier2ServerDimension("keywords")).toBe(true);
    expect(isTier2ServerDimension("externalIp")).toBe(true);
    expect(isTier2ServerDimension("internalIp")).toBe(true);
    expect(isTier2ServerDimension("country")).toBe(true);
    // `sameSensor` is excluded in Phase 1 because the Tier 2 sensor
    // pivot needs a `triage:read`-compatible sensor name → ID lookup
    // that does not yet exist (#453). Excluding it here also blocks
    // hash-restore from queueing a known-bad server fetch when a
    // shared link carries `step=sameSensor:<name>` under `mode=tier2`.
    expect(isTier2ServerDimension("sameSensor")).toBe(false);
    // Client-intersection dimensions
    expect(isTier2ServerDimension("ja3")).toBe(false);
    expect(isTier2ServerDimension("host")).toBe(false);
    expect(isTier2ServerDimension("port")).toBe(false);
  });
});

describe("buildTier2Filter", () => {
  it("packs an external IP into a side-agnostic endpoint entry", () => {
    const filter = buildTier2Filter({
      periodStartIso: PERIOD.startIso,
      periodEndIso: PERIOD.endIso,
      dimension: "externalIp",
      valueKey: "203.0.113.10",
    });
    expect(filter).toEqual({
      start: PERIOD.startIso,
      end: PERIOD.endIso,
      endpoints: [
        {
          direction: null,
          custom: {
            hosts: ["203.0.113.10"],
            networks: [],
            ranges: [],
          },
        },
      ],
    });
  });

  it("emits the same shape for internalIp (Tier 1 dimensions are 1:1 with Tier 2)", () => {
    const filter = buildTier2Filter({
      periodStartIso: PERIOD.startIso,
      periodEndIso: PERIOD.endIso,
      dimension: "internalIp",
      valueKey: "10.0.0.1",
    });
    expect(filter?.endpoints?.[0]?.direction).toBeNull();
    expect(filter?.endpoints?.[0]?.custom?.hosts).toEqual(["10.0.0.1"]);
  });

  it("maps country to the countries filter", () => {
    const filter = buildTier2Filter({
      periodStartIso: PERIOD.startIso,
      periodEndIso: PERIOD.endIso,
      dimension: "country",
      valueKey: "US",
    });
    expect(filter?.countries).toEqual(["US"]);
  });

  it("parses categories as integers", () => {
    const filter = buildTier2Filter({
      periodStartIso: PERIOD.startIso,
      periodEndIso: PERIOD.endIso,
      dimension: "categories",
      valueKey: "7",
    });
    expect(filter?.categories).toEqual([7]);
  });

  it("rejects malformed category integers", () => {
    expect(
      buildTier2Filter({
        periodStartIso: PERIOD.startIso,
        periodEndIso: PERIOD.endIso,
        dimension: "categories",
        valueKey: "not-a-number",
      }),
    ).toBeNull();
  });

  it("rejects empty IP values", () => {
    expect(
      buildTier2Filter({
        periodStartIso: PERIOD.startIso,
        periodEndIso: PERIOD.endIso,
        dimension: "externalIp",
        valueKey: "  ",
      }),
    ).toBeNull();
  });
});
