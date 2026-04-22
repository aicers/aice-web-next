import { describe, expect, it } from "vitest";

import {
  computePeriodRange,
  DEFAULT_PERIOD_KEY,
  matchesPeriodKey,
  PERIOD_KEYS,
} from "@/lib/detection";

describe("computePeriodRange", () => {
  const now = new Date("2026-04-22T12:00:00Z");

  it.each([
    ["1h", "2026-04-22T11:00:00.000Z"],
    ["12h", "2026-04-22T00:00:00.000Z"],
    ["1d", "2026-04-21T12:00:00.000Z"],
    ["1w", "2026-04-15T12:00:00.000Z"],
  ] as const)("fixed-duration chip %s subtracts the right offset", (key, start) => {
    const range = computePeriodRange(key, now);
    expect(range).toEqual({ start, end: "2026-04-22T12:00:00.000Z" });
  });

  it("uses calendar months for the 1m/3m/6m chips", () => {
    expect(computePeriodRange("1m", now).start).toBe(
      "2026-03-22T12:00:00.000Z",
    );
    expect(computePeriodRange("3m", now).start).toBe(
      "2026-01-22T12:00:00.000Z",
    );
    expect(computePeriodRange("6m", now).start).toBe(
      "2025-10-22T12:00:00.000Z",
    );
  });

  it("uses calendar years for the 1y/3y chips", () => {
    expect(computePeriodRange("1y", now).start).toBe(
      "2025-04-22T12:00:00.000Z",
    );
    expect(computePeriodRange("3y", now).start).toBe(
      "2023-04-22T12:00:00.000Z",
    );
  });

  it("has 1h as the documented default", () => {
    expect(DEFAULT_PERIOD_KEY).toBe("1h");
    expect(PERIOD_KEYS).toContain(DEFAULT_PERIOD_KEY);
  });
});

describe("computePeriodRange — month/year edge cases", () => {
  it("clamps day-of-month when the target month is shorter (May 31 - 1 month)", () => {
    // Regression: `setUTCMonth(-1)` on May 31 rolled forward to May 1
    // because April has 30 days. Expected: land on April 30 so the
    // window actually reaches into April.
    const end = new Date("2026-05-31T12:00:00.000Z");
    expect(computePeriodRange("1m", end).start).toBe(
      "2026-04-30T12:00:00.000Z",
    );
  });

  it("clamps day-of-month for 3m at month-end (May 31 - 3 months → Feb 28)", () => {
    const end = new Date("2026-05-31T12:00:00.000Z");
    expect(computePeriodRange("3m", end).start).toBe(
      "2026-02-28T12:00:00.000Z",
    );
  });

  it("clamps leap day when subtracting a year (Feb 29 - 1 year → Feb 28)", () => {
    const end = new Date("2024-02-29T08:30:00.000Z");
    expect(computePeriodRange("1y", end).start).toBe(
      "2023-02-28T08:30:00.000Z",
    );
  });

  it("crosses a year boundary cleanly for 3m at January (Jan 31 - 3 months → Oct 31)", () => {
    const end = new Date("2026-01-31T00:00:00.000Z");
    expect(computePeriodRange("3m", end).start).toBe(
      "2025-10-31T00:00:00.000Z",
    );
  });

  it("preserves sub-minute precision of end in the ISO output", () => {
    // Regression guard for the drawer-side fix: the range helper
    // itself must not round, or the truncation-on-Apply bug would
    // resurface from the server side.
    const end = new Date("2026-04-22T12:34:56.789Z");
    const range = computePeriodRange("1h", end);
    expect(range.end).toBe("2026-04-22T12:34:56.789Z");
    expect(range.start).toBe("2026-04-22T11:34:56.789Z");
  });
});

describe("matchesPeriodKey", () => {
  const now = new Date("2026-04-22T12:00:00Z");

  it("round-trips every chip", () => {
    for (const key of PERIOD_KEYS) {
      const range = computePeriodRange(key, now);
      expect(matchesPeriodKey(range, now)).toBe(key);
    }
  });

  it("returns null for a user-edited range that does not match any chip", () => {
    expect(
      matchesPeriodKey(
        { start: "2026-04-01T00:00:00.000Z", end: "2026-04-02T00:00:00.000Z" },
        now,
      ),
    ).toBeNull();
  });
});
