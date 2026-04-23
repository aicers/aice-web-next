import { describe, expect, it } from "vitest";

import type { Filter } from "@/lib/detection/filter";
import {
  CHIP_DIMENSION_CAP,
  type SummarizeFilterContext,
  type SummarizeFilterLabels,
  summarizeFilter,
} from "@/lib/detection/filter-summary";

const LABELS: SummarizeFilterLabels = {
  sensor: "Sensor",
  sensorAggregate: "{count} selected",
  period: "Period",
  periodOptions: {
    "1h": "Last 1h",
    "12h": "Last 12h",
    "1d": "Last 1d",
    "1w": "Last 1w",
    "1m": "Last 1m",
    "3m": "Last 3m",
    "6m": "Last 6m",
    "1y": "Last 1y",
    "3y": "Last 3y",
  },
  formatRange: ({ start, end }) => `${start} – ${end}`,
  direction: "Direction",
  directionValues: {
    OUTBOUND: "Outbound",
    INTERNAL: "Internal",
    INBOUND: "Inbound",
  },
  confidence: "Confidence",
  source: "Source",
  destination: "Destination",
  keywords: "Keywords",
  hostnames: "Hostnames",
  userIds: "User IDs",
  userNames: "User Names",
  userDepartments: "User Departments",
  levels: "Threat Level",
  countries: "Threat Country",
  learningMethods: "AI Model Type",
  categories: "Threat Category",
  kinds: "Threat Name",
  categoricalAggregate: ({ label, count }) => `${label}: ${count}`,
};

const CONTEXT: SummarizeFilterContext = {
  period: null,
  sensorOptions: [
    { id: "sensor-a", name: "Alpha" },
    { id: "sensor-b", name: "Bravo" },
    { id: "sensor-c", name: "Charlie" },
    { id: "sensor-d", name: "Delta" },
    { id: "sensor-e", name: "Echo" },
  ],
  categoricalOptions: {
    levels: [
      { value: 1, label: "Low" },
      { value: 2, label: "Medium" },
      { value: 3, label: "High" },
    ],
    countries: [
      { value: "US", label: "United States (US)" },
      { value: "DE", label: "Germany (DE)" },
    ],
    learningMethods: [
      { value: "UNSUPERVISED", label: "Unsupervised" },
      { value: "SEMI_SUPERVISED", label: "Semi-supervised" },
    ],
    categories: [
      { value: 1, label: "Reconnaissance" },
      { value: 2, label: "Initial Access" },
    ],
    kinds: [
      { value: "HttpThreat", label: "HTTP Threat" },
      { value: "PortScan", label: "Port Scan" },
    ],
  },
};

function structured(input: Record<string, unknown>): Filter {
  return {
    mode: "structured",
    input: input as Filter extends { mode: "structured"; input: infer I }
      ? I
      : never,
  };
}

describe("summarizeFilter (structured)", () => {
  it("emits no chips for an empty structured filter", () => {
    expect(summarizeFilter(structured({}), LABELS, CONTEXT)).toEqual([]);
  });

  it("emits a period chip resolving to the preset option", () => {
    const chips = summarizeFilter(structured({}), LABELS, {
      ...CONTEXT,
      period: "1h",
    });
    expect(chips).toEqual([
      expect.objectContaining({
        id: "period",
        label: "Period",
        value: "Last 1h",
        focus: "period",
        remove: { kind: "period" },
      }),
    ]);
  });

  it("emits source / destination scalar chips with drawer focus and removal", () => {
    const chips = summarizeFilter(
      structured({ source: "10.0.0.5", destination: "203.0.113.45" }),
      LABELS,
      CONTEXT,
    );
    expect(chips.map((c) => c.id)).toEqual(["source", "destination"]);
    expect(chips[0].focus).toBe("source");
    expect(chips[0].remove).toEqual({ kind: "scalarField", field: "source" });
    expect(chips[1].remove).toEqual({
      kind: "scalarField",
      field: "destination",
    });
  });

  it("renders one chip per tag value up to the cap; collapses beyond it", () => {
    const few = summarizeFilter(
      structured({ keywords: ["a", "b", "c"] }),
      LABELS,
      CONTEXT,
    );
    expect(few).toHaveLength(3);
    expect(few.every((c) => c.focus === "keywords")).toBe(true);

    const many = summarizeFilter(
      structured({ keywords: ["a", "b", "c", "d"] }),
      LABELS,
      CONTEXT,
    );
    expect(many).toHaveLength(1);
    expect(many[0].aggregate).toBe(true);
    expect(many[0].remove).toEqual({
      kind: "arrayAggregate",
      field: "keywords",
    });
  });

  it("emits direction chips only when the selection is not all three", () => {
    expect(
      summarizeFilter(
        structured({ directions: ["OUTBOUND", "INTERNAL", "INBOUND"] }),
        LABELS,
        CONTEXT,
      ),
    ).toEqual([]);
    const chips = summarizeFilter(
      structured({ directions: ["OUTBOUND"] }),
      LABELS,
      CONTEXT,
    );
    expect(chips).toHaveLength(1);
    expect(chips[0].id).toBe("direction:OUTBOUND");
    expect(chips[0].remove).toEqual({
      kind: "directionValue",
      value: "OUTBOUND",
    });
  });

  it("emits a confidence chip with a drawer focus and removal target", () => {
    const chips = summarizeFilter(
      structured({ confidenceMin: 0.5, confidenceMax: 0.9 }),
      LABELS,
      CONTEXT,
    );
    expect(chips).toHaveLength(1);
    expect(chips[0].focus).toBe("confidence");
    expect(chips[0].remove).toEqual({ kind: "confidence" });
  });

  it("renders sensor chips with id → name resolution", () => {
    const chips = summarizeFilter(
      structured({ sensors: ["sensor-a", "sensor-b", "sensor-c"] }),
      LABELS,
      CONTEXT,
    );
    expect(chips.map((c) => c.value)).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(chips.every((c) => c.focus === "sensor")).toBe(true);
  });

  it("collapses four or more sensors to a single aggregate chip", () => {
    const chips = summarizeFilter(
      structured({
        sensors: ["sensor-a", "sensor-b", "sensor-c", "sensor-d"],
      }),
      LABELS,
      CONTEXT,
    );
    expect(chips).toHaveLength(1);
    expect(chips[0].aggregate).toBe(true);
    expect(chips[0].remove).toEqual({
      kind: "arrayAggregate",
      field: "sensors",
    });
  });

  it("renders categorical multi-select chips with localised labels", () => {
    const chips = summarizeFilter(
      structured({ levels: [1, 3], kinds: ["HttpThreat"] }),
      LABELS,
      CONTEXT,
    );
    expect(chips.map((c) => c.value)).toEqual(["Low", "High", "HTTP Threat"]);
  });

  it("falls back to the raw sensor id when no option matches", () => {
    const chips = summarizeFilter(
      structured({ sensors: ["sensor-unknown"] }),
      LABELS,
      CONTEXT,
    );
    expect(chips).toHaveLength(1);
    expect(chips[0].value).toBe("sensor-unknown");
  });

  it("exposes the per-dimension cap at 3", () => {
    expect(CHIP_DIMENSION_CAP).toBe(3);
  });
});

describe("summarizeFilter (query mode — forward-compat)", () => {
  it("returns no chips; the shell renders a query pill outside this helper", () => {
    // v1 deliberately refuses per-field decomposition for a
    // `mode: "query"` filter. The query language can express OR /
    // NOT / regex that structured chips cannot represent, so the
    // shell substitutes a single editable pill. Confirmed in the
    // helper-level test so a future refactor cannot silently drop
    // the forward-compat guard.
    const filter: Filter = { mode: "query", text: "level:HIGH" };
    expect(summarizeFilter(filter, LABELS, CONTEXT)).toEqual([]);
  });
});
