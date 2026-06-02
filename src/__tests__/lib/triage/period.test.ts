import { describe, expect, it } from "vitest";

import {
  defaultTriagePeriod,
  parseTriagePeriod,
  presetTriagePeriod,
  TRIAGE_DEFAULT_DURATION_MS,
  TRIAGE_MAX_DURATION_MS,
  TRIAGE_MAX_LOOKBACK_MS,
  TRIAGE_PERIOD_PRESETS,
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

  it("clamps a start older than the 180-day lookback floor forward", () => {
    // 1B-3 (#458) expanded the lookback to 180 days — the corpus A
    // retention floor. A start more than 180 days before `NOW` is
    // pulled forward to the floor, then the 30-day duration cap
    // applies on top.
    const start = "2024-01-01T00:00:00.000Z";
    const end = "2026-05-09T00:00:00.000Z";
    const result = parseTriagePeriod(start, end, NOW);
    expect(result.clamped).toBe(true);
    // Lookback clamp fires first; duration cap then trims further so
    // the window does not exceed 30 days.
    expect(Date.parse(result.period.startIso)).toBe(
      Date.parse(end) - TRIAGE_MAX_DURATION_MS,
    );
    expect(result.period.endIso).toBe(end);
  });

  it("accepts a start 60 days before now without clamping the lookback", () => {
    // The 180-day floor explicitly admits this case which would have
    // been clamped under the previous 30-day lookback.
    const start = new Date(
      NOW.getTime() - 60 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const end = new Date(
      NOW.getTime() - 50 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const result = parseTriagePeriod(start, end, NOW);
    expect(result.clamped).toBe(false);
    expect(result.period).toEqual({ startIso: start, endIso: end });
  });

  it("never lets the window exceed 30 days even when start is well within the lookback", () => {
    // 90-day window: lookback clamp does not fire (start is inside the
    // 180-day floor), but the duration cap shrinks `start` forward so
    // the visible window stays at 30 days.
    const start = "2026-02-08T00:00:00.000Z";
    const end = "2026-05-09T00:00:00.000Z";
    const result = parseTriagePeriod(start, end, NOW);
    expect(result.clamped).toBe(true);
    const duration =
      Date.parse(result.period.endIso) - Date.parse(result.period.startIso);
    expect(duration).toBe(TRIAGE_MAX_DURATION_MS);
    expect(result.period.endIso).toBe(end);
  });

  it("expands TRIAGE_MAX_LOOKBACK_MS to 180 days", () => {
    // Sanity: a regression that re-shrinks the lookback to 30 days
    // would silently break the Baseline-mode period range.
    expect(TRIAGE_MAX_LOOKBACK_MS).toBe(180 * 24 * 60 * 60 * 1000);
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

describe("presetTriagePeriod", () => {
  it("produces a window of exactly durationMs ending at now", () => {
    const period = presetTriagePeriod(7 * 24 * 60 * 60 * 1000, NOW);
    expect(period.endIso).toBe(NOW.toISOString());
    expect(Date.parse(period.endIso) - Date.parse(period.startIso)).toBe(
      7 * 24 * 60 * 60 * 1000,
    );
  });
});

describe("TRIAGE_PERIOD_PRESETS", () => {
  it("exposes the 1d / 3d / 1w / 2w / 1m presets in order", () => {
    expect(TRIAGE_PERIOD_PRESETS.map((p) => p.key)).toEqual([
      "1d",
      "3d",
      "1w",
      "2w",
      "1m",
    ]);
  });

  it("keeps every preset within the 30-day duration cap", () => {
    for (const preset of TRIAGE_PERIOD_PRESETS) {
      expect(preset.durationMs).toBeLessThanOrEqual(TRIAGE_MAX_DURATION_MS);
    }
  });

  it("makes the longest preset exactly the duration cap", () => {
    const longest = Math.max(...TRIAGE_PERIOD_PRESETS.map((p) => p.durationMs));
    expect(longest).toBe(TRIAGE_MAX_DURATION_MS);
    // The last preset (1 month) is the one that hits the cap.
    expect(TRIAGE_PERIOD_PRESETS.at(-1)?.durationMs).toBe(
      TRIAGE_MAX_DURATION_MS,
    );
  });

  it("applied at NOW, no preset trips the duration cap or lookback floor", () => {
    for (const preset of TRIAGE_PERIOD_PRESETS) {
      const period = presetTriagePeriod(preset.durationMs, NOW);
      const duration = Date.parse(period.endIso) - Date.parse(period.startIso);
      expect(duration).toBeLessThanOrEqual(TRIAGE_MAX_DURATION_MS);
      expect(NOW.getTime() - Date.parse(period.startIso)).toBeLessThanOrEqual(
        TRIAGE_MAX_LOOKBACK_MS,
      );
    }
  });
});
