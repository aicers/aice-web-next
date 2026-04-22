import { describe, expect, it } from "vitest";
import type { Filter } from "@/lib/detection/filter";
import {
  buildDetectionFilterBar,
  type DetectionFilterBarLabels,
} from "@/lib/detection/filter-bar";
import type { PeriodKey } from "@/lib/detection/period";
import type { PivotChip } from "@/lib/detection/url-filters";

const START = "2026-04-22T11:00:00.000Z";
const END = "2026-04-22T12:00:00.000Z";

function labels(): DetectionFilterBarLabels {
  return {
    confidenceChipLabel: "Confidence",
    activeChipsEmpty: "No filter applied.",
    periodOptions: {
      "1h": "Last 1 hour",
      "12h": "Last 12 hours",
      "1d": "Last 1 day",
      "1w": "Last 1 week",
      "1m": "Last 1 month",
      "3m": "Last 3 months",
      "6m": "Last 6 months",
      "1y": "Last 1 year",
      "3y": "Last 3 years",
    } satisfies Record<PeriodKey, string>,
    formatRange: ({ start, end }) => `${start} – ${end}`,
  };
}

function structured(
  overrides: Partial<Filter & { mode: "structured" }> = {},
): Filter {
  return {
    mode: "structured",
    input: {
      start: START,
      end: END,
      ...(overrides.mode === "structured" ? overrides.input : {}),
    },
  };
}

describe("buildDetectionFilterBar", () => {
  it("keeps the period summary when a non-default confidence range is applied", () => {
    // Regression: a previous revision switched the chip bar to a chip-
    // list branch whenever any chip existed, which hid the period / time
    // window summary once a confidence chip was rendered. Applying a
    // non-default confidence range must keep the time summary visible
    // alongside the confidence chip so the bar still reflects the full
    // applied filter.
    const filter: Filter = {
      mode: "structured",
      input: { start: START, end: END, confidenceMin: 0.7, confidenceMax: 1 },
    };
    const { summary, chips } = buildDetectionFilterBar({
      filter,
      period: "1h",
      pivotChips: [],
      labels: labels(),
    });

    expect(summary).toBe("Last 1 hour");
    expect(chips).toEqual([
      { id: "confidence", label: "Confidence", value: "0.70 – 1.00" },
    ]);
  });

  it("falls back to the explicit range summary when no period is set", () => {
    const filter: Filter = {
      mode: "structured",
      input: {
        start: START,
        end: END,
        confidenceMin: 0.5,
        confidenceMax: 0.9,
      },
    };
    const { summary, chips } = buildDetectionFilterBar({
      filter,
      period: null,
      pivotChips: [],
      labels: labels(),
    });

    expect(summary).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2} – /);
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({ id: "confidence", value: "0.50 – 0.90" });
  });

  it("renders pivot chips and the confidence chip together and keeps the period summary", () => {
    const pivotChips: PivotChip[] = [
      { id: "source", label: "Source IP", value: "10.0.0.1" },
    ];
    const filter: Filter = {
      mode: "structured",
      input: { start: START, end: END, confidenceMin: 0.7, confidenceMax: 1 },
    };
    const { summary, chips } = buildDetectionFilterBar({
      filter,
      period: "1h",
      pivotChips,
      labels: labels(),
    });

    expect(summary).toBe("Last 1 hour");
    expect(chips.map((c) => c.id)).toEqual(["source", "confidence"]);
  });

  it("omits the confidence chip at the [0, 1] default", () => {
    const filter = structured();
    const { summary, chips } = buildDetectionFilterBar({
      filter,
      period: "1h",
      pivotChips: [],
      labels: labels(),
    });

    expect(summary).toBe("Last 1 hour");
    expect(chips).toEqual([]);
  });

  it("omits the confidence chip when both fields are explicitly set to the default [0, 1]", () => {
    // Regression: the helper used to treat any explicit confidenceMin
    // / confidenceMax pair as an active filter and rendered a chip for
    // {confidenceMin: 0, confidenceMax: 1} even though that range is
    // the semantic default. Matches the acceptance criterion that
    // default values produce no chip regardless of whether the keys
    // are omitted or explicitly present.
    const filter: Filter = {
      mode: "structured",
      input: {
        start: START,
        end: END,
        confidenceMin: 0,
        confidenceMax: 1,
      },
    };
    const { summary, chips } = buildDetectionFilterBar({
      filter,
      period: "1h",
      pivotChips: [],
      labels: labels(),
    });

    expect(summary).toBe("Last 1 hour");
    expect(chips).toEqual([]);
  });

  it("renders the confidence chip when only one bound is non-default", () => {
    const filter: Filter = {
      mode: "structured",
      input: {
        start: START,
        end: END,
        confidenceMin: 0.5,
        confidenceMax: null,
      },
    };
    const { summary, chips } = buildDetectionFilterBar({
      filter,
      period: "1h",
      pivotChips: [],
      labels: labels(),
    });

    expect(summary).toBe("Last 1 hour");
    expect(chips).toEqual([
      { id: "confidence", label: "Confidence", value: "0.50 – 1.00" },
    ]);
  });

  it("falls back to the empty-state label when the filter has no time or period", () => {
    const filter: Filter = { mode: "structured", input: {} };
    const { summary, chips } = buildDetectionFilterBar({
      filter,
      period: null,
      pivotChips: [],
      labels: labels(),
    });

    expect(summary).toBe("No filter applied.");
    expect(chips).toEqual([]);
  });
});
