import { describe, expect, it } from "vitest";

import {
  CHIP_DIMENSION_CAP,
  summarizeFilter,
} from "@/lib/detection/filter-summary";

const LABELS = {
  sensor: "Sensor",
  sensorAggregate: "{count} selected",
};

const OPTIONS = [
  { id: "sensor-a", name: "Alpha" },
  { id: "sensor-b", name: "Bravo" },
  { id: "sensor-c", name: "Charlie" },
  { id: "sensor-d", name: "Delta" },
  { id: "sensor-e", name: "Echo" },
];

describe("summarizeFilter", () => {
  it("returns no chips when the filter has no sensor IDs", () => {
    expect(summarizeFilter({}, OPTIONS, LABELS)).toEqual([]);
    expect(summarizeFilter({ sensors: [] }, OPTIONS, LABELS)).toEqual([]);
    expect(summarizeFilter({ sensors: null }, OPTIONS, LABELS)).toEqual([]);
  });

  it("renders one chip per sensor for 1–3 selections", () => {
    const chips = summarizeFilter(
      { sensors: ["sensor-a", "sensor-b", "sensor-c"] },
      OPTIONS,
      LABELS,
    );
    expect(chips).toEqual([
      { id: "sensor:sensor-a", label: "Sensor", value: "Alpha" },
      { id: "sensor:sensor-b", label: "Sensor", value: "Bravo" },
      { id: "sensor:sensor-c", label: "Sensor", value: "Charlie" },
    ]);
  });

  it("collapses four or more sensors to a single aggregate chip", () => {
    const chips = summarizeFilter(
      { sensors: ["sensor-a", "sensor-b", "sensor-c", "sensor-d"] },
      OPTIONS,
      LABELS,
    );
    expect(chips).toEqual([
      { id: "sensor:aggregate", label: "Sensor", value: "4 selected" },
    ]);
  });

  it("falls back to the raw ID when no option matches (cache miss)", () => {
    // A committed filter whose sensor is no longer in the session
    // options cache must still surface as a chip — silently dropping
    // the filter would mislead the operator about what is in effect.
    const chips = summarizeFilter(
      { sensors: ["sensor-unknown"] },
      OPTIONS,
      LABELS,
    );
    expect(chips).toEqual([
      { id: "sensor:sensor-unknown", label: "Sensor", value: "sensor-unknown" },
    ]);
  });

  it("the individual-chip cap is 3", () => {
    expect(CHIP_DIMENSION_CAP).toBe(3);
  });
});
