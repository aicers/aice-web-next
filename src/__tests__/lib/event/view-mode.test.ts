import { describe, expect, it } from "vitest";

import {
  coerceViewMode,
  DEFAULT_VIEW_MODE,
  isViewMode,
  parseViewModeFromSearchParams,
} from "@/lib/event";

describe("view-mode", () => {
  it("recognizes the supported modes", () => {
    expect(isViewMode("events")).toBe(true);
    expect(isViewMode("statistics")).toBe(true);
    expect(isViewMode("timeseries")).toBe(true);
    expect(isViewMode("histogram")).toBe(false);
  });

  it("defaults to the events table", () => {
    expect(DEFAULT_VIEW_MODE).toBe("events");
    expect(coerceViewMode(undefined)).toBe("events");
    expect(coerceViewMode("nope")).toBe("events");
    expect(coerceViewMode("statistics")).toBe("statistics");
    expect(coerceViewMode("timeseries")).toBe("timeseries");
  });

  it("parses the view param, ignoring a repeated (array) value", () => {
    expect(parseViewModeFromSearchParams({ view: "statistics" })).toBe(
      "statistics",
    );
    expect(parseViewModeFromSearchParams({ view: "timeseries" })).toBe(
      "timeseries",
    );
    expect(parseViewModeFromSearchParams({})).toBe("events");
    expect(
      parseViewModeFromSearchParams({ view: ["statistics", "events"] }),
    ).toBe("events");
  });
});
