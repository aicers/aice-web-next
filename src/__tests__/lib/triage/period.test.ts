import { describe, expect, it } from "vitest";

import {
  defaultTriagePeriod,
  parseTriagePeriod,
  TRIAGE_DEFAULT_DURATION_MS,
  TRIAGE_MAX_DURATION_MS,
  TRIAGE_MAX_LOOKBACK_MS,
} from "@/lib/triage";

const NOW = new Date("2026-05-09T12:00:00.000Z");

describe("defaultTriagePeriod", () => {
  it("produces a 24-hour window ending at now", () => {
    const period = defaultTriagePeriod(NOW);
    expect(period.endIso).toBe("2026-05-09T12:00:00.000Z");
    expect(Date.parse(period.endIso) - Date.parse(period.startIso)).toBe(
      TRIAGE_DEFAULT_DURATION_MS,
    );
  });
});

describe("parseTriagePeriod", () => {
  it("falls back to default when both inputs are missing", () => {
    const result = parseTriagePeriod(undefined, undefined, NOW);
    expect(result.clamped).toBe(false);
    expect(result.period).toEqual(defaultTriagePeriod(NOW));
  });

  it("falls back to default when only one input is provided", () => {
    const result = parseTriagePeriod(
      "2026-05-08T00:00:00.000Z",
      undefined,
      NOW,
    );
    expect(result.period).toEqual(defaultTriagePeriod(NOW));
  });

  it("accepts a valid in-range window unchanged", () => {
    const start = "2026-05-08T00:00:00.000Z";
    const end = "2026-05-09T00:00:00.000Z";
    const result = parseTriagePeriod(start, end, NOW);
    expect(result.clamped).toBe(false);
    expect(result.period).toEqual({ startIso: start, endIso: end });
  });

  it("clamps a future end back to now", () => {
    const start = "2026-05-09T11:00:00.000Z";
    const end = "2026-05-09T13:00:00.000Z";
    const result = parseTriagePeriod(start, end, NOW);
    expect(result.clamped).toBe(true);
    expect(result.period.endIso).toBe(NOW.toISOString());
    expect(result.period.startIso).toBe(start);
  });

  it("clamps a start older than 30 days forward", () => {
    const start = "2025-01-01T00:00:00.000Z";
    const end = "2026-05-09T00:00:00.000Z";
    const result = parseTriagePeriod(start, end, NOW);
    expect(result.clamped).toBe(true);
    expect(Date.parse(result.period.startIso)).toBe(
      NOW.getTime() - TRIAGE_MAX_LOOKBACK_MS,
    );
    expect(result.period.endIso).toBe(end);
  });

  it("never lets the window exceed 30 days even with old start + recent end", () => {
    // Lookback clamp fires first (start is older than 30 days), then
    // the duration cap is a no-op because the lookback already trims
    // the start forward. The post-condition is the same: the visible
    // window is at most 30 days.
    const start = "2026-04-08T00:00:00.000Z";
    const end = "2026-05-09T00:00:00.000Z";
    const result = parseTriagePeriod(start, end, NOW);
    expect(result.clamped).toBe(true);
    const duration =
      Date.parse(result.period.endIso) - Date.parse(result.period.startIso);
    expect(duration).toBeLessThanOrEqual(TRIAGE_MAX_DURATION_MS);
    expect(result.period.endIso).toBe(end);
  });

  it("falls back to default when end is not after start", () => {
    const start = "2026-05-09T00:00:00.000Z";
    const end = "2026-05-08T00:00:00.000Z";
    const result = parseTriagePeriod(start, end, NOW);
    expect(result.clamped).toBe(true);
    expect(result.period).toEqual(defaultTriagePeriod(NOW));
  });

  it("falls back to default when inputs are not parseable", () => {
    const result = parseTriagePeriod("not-a-date", "also-not", NOW);
    expect(result.clamped).toBe(false);
    expect(result.period).toEqual(defaultTriagePeriod(NOW));
  });
});
