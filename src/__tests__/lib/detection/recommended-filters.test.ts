import { describe, expect, it } from "vitest";

import { computePeriodRange } from "@/lib/detection/period";
import {
  buildRecommendedFilter,
  RECOMMENDED_PRESETS,
} from "@/lib/detection/recommended-filters";

describe("RECOMMENDED_PRESETS", () => {
  it("ships the issue-#287 starter set in display order", () => {
    expect(RECOMMENDED_PRESETS.map((p) => p.id)).toEqual([
      "last-3-years",
      "last-1-year-inbound",
      "last-1-year",
    ]);
  });

  it("uses unique ids", () => {
    const ids = new Set(RECOMMENDED_PRESETS.map((p) => p.id));
    expect(ids.size).toBe(RECOMMENDED_PRESETS.length);
  });

  it("never sets start / end on the preset's `extra` (period owns those)", () => {
    for (const preset of RECOMMENDED_PRESETS) {
      const extra = preset.extra as Record<string, unknown> | undefined;
      expect(extra?.start).toBeUndefined();
      expect(extra?.end).toBeUndefined();
    }
  });

  it("references valid `recommendedFilters.<key>` i18n keys for both locales", async () => {
    const en = await import("@/i18n/messages/en.json").then((m) => m.default);
    const ko = await import("@/i18n/messages/ko.json").then((m) => m.default);
    for (const preset of RECOMMENDED_PRESETS) {
      const path = ["detection", "recommendedFilters", preset.nameKey];
      const enValue = path.reduce<unknown>(
        (acc, key) =>
          acc && typeof acc === "object" && !Array.isArray(acc)
            ? (acc as Record<string, unknown>)[key]
            : undefined,
        en,
      );
      const koValue = path.reduce<unknown>(
        (acc, key) =>
          acc && typeof acc === "object" && !Array.isArray(acc)
            ? (acc as Record<string, unknown>)[key]
            : undefined,
        ko,
      );
      expect(typeof enValue).toBe("string");
      expect(typeof koValue).toBe("string");
    }
  });
});

describe("buildRecommendedFilter", () => {
  const now = new Date("2026-04-22T12:00:00Z");

  it("builds a structured `Filter` whose start/end match the preset's period", () => {
    const preset = RECOMMENDED_PRESETS.find((p) => p.id === "last-3-years");
    if (!preset) throw new Error("missing preset");
    const expected = computePeriodRange(preset.period, now);
    const filter = buildRecommendedFilter(preset, now);
    expect(filter.mode).toBe("structured");
    if (filter.mode !== "structured") throw new Error("unreachable");
    expect(filter.input.start).toBe(expected.start);
    expect(filter.input.end).toBe(expected.end);
    expect(filter.input.directions).toBeUndefined();
  });

  it("layers the preset's `extra` onto the period range", () => {
    const preset = RECOMMENDED_PRESETS.find(
      (p) => p.id === "last-1-year-inbound",
    );
    if (!preset) throw new Error("missing preset");
    const expected = computePeriodRange(preset.period, now);
    const filter = buildRecommendedFilter(preset, now);
    if (filter.mode !== "structured") throw new Error("unreachable");
    expect(filter.input.start).toBe(expected.start);
    expect(filter.input.end).toBe(expected.end);
    expect(filter.input.directions).toEqual(["INBOUND"]);
  });

  it("uses `new Date()` when `now` is omitted so the range is relative to activation time", () => {
    const before = Date.now();
    const preset = RECOMMENDED_PRESETS[0];
    if (!preset) throw new Error("missing preset");
    const filter = buildRecommendedFilter(preset);
    if (filter.mode !== "structured") throw new Error("unreachable");
    if (typeof filter.input.end !== "string") {
      throw new Error("expected end string");
    }
    const after = Date.now();
    const end = Date.parse(filter.input.end);
    expect(end).toBeGreaterThanOrEqual(before);
    expect(end).toBeLessThanOrEqual(after);
  });
});
