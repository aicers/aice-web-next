import { describe, expect, it } from "vitest";

import type { FilterDrawerOptions } from "@/components/detection/filter-drawer";
import type { FilterMultiSelectLabels } from "@/components/detection/filter-multi-select";
import type { Filter } from "@/lib/detection/filter";
import {
  CHIP_DIMENSION_CAP,
  type FilterChipSpec,
  type SummarizeFilterLabels,
  summarizeFilter,
} from "@/lib/detection/filter-summary";
import type {
  EventListFilterInput,
  LearningMethod,
} from "@/lib/detection/types";

const SENSOR_OPTIONS = [
  { id: "sensor-a", name: "Alpha" },
  { id: "sensor-b", name: "Bravo" },
  { id: "sensor-c", name: "Charlie" },
  { id: "sensor-d", name: "Delta" },
];

const DRAWER_OPTIONS: FilterDrawerOptions = {
  levels: [
    { value: 1, label: "Low" },
    { value: 2, label: "Medium" },
    { value: 3, label: "High" },
  ],
  countries: [
    { value: "US", label: "United States (US)" },
    { value: "KR", label: "Korea (KR)" },
    { value: "JP", label: "Japan (JP)" },
  ],
  learningMethods: [
    { value: "SEMI_SUPERVISED" as LearningMethod, label: "Semi-supervised" },
    { value: "UNSUPERVISED" as LearningMethod, label: "Unsupervised" },
  ],
  categories: [
    { value: 1, label: "Reconnaissance" },
    { value: 2, label: "Initial Access" },
  ],
  kinds: [
    { value: "HttpThreat", label: "HTTP Threat" },
    { value: "NetworkThreat", label: "Network Threat" },
  ],
};

const MULTI_SELECT_LABELS: FilterMultiSelectLabels = {
  allToggle: "All",
  searchPlaceholder: "Search",
  noOptionsMatch: "No matches",
  summaryNone: "None",
  summaryAll: "All",
  summarySome: (count: number) => `${count} selected`,
  expand: "Expand",
  collapse: "Collapse",
};

const LABELS: SummarizeFilterLabels = {
  activeEmpty: "No filter applied.",
  periodLabel: "Period",
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
  },
  formatRange: ({ start, end }) => `${start} – ${end}`,
  confidenceLabel: "Confidence",
  directionChips: {
    label: "Direction",
    values: { OUTBOUND: "Outbound", INTERNAL: "Internal", INBOUND: "Inbound" },
  },
  endpointChips: {
    source: "Src",
    destination: "Dst",
    aggregate: "Network: {count} rules",
  },
  sensor: "Sensor",
  sensorAggregate: "{count} selected",
  pivot: {
    source: "Source",
    destination: "Destination",
    kind: "Kind",
    origPort: "Source port",
    respPort: "Destination port",
    proto: "Protocol",
    window: "Window",
    windowLastDay: "Last 24 hours",
    windowLastWeek: "Last 7 days",
    keywords: "Keywords",
    hostnames: "Hostnames",
    userIds: "User IDs",
    userNames: "User Names",
    userDepartments: "User Departments",
    countAggregate: (label, count) => `${label}: ${count}`,
  },
  multiSelectFields: {
    levels: "Level",
    countries: "Country",
    learningMethods: "Learning Method",
    categories: "Category",
    kinds: "Kind",
  },
  multiSelectLabels: MULTI_SELECT_LABELS,
};

const START = "2026-04-22T11:00:00.000Z";
const END = "2026-04-22T12:00:00.000Z";

function structured(overrides: Partial<EventListFilterInput> = {}): Filter {
  return {
    mode: "structured",
    input: { start: START, end: END, ...overrides },
  };
}

function context(
  filter: Filter,
  overrides: {
    endpoints?: Parameters<typeof summarizeFilter>[0]["endpoints"];
    pivotOnly?: Parameters<typeof summarizeFilter>[0]["pivotOnly"];
    period?: Parameters<typeof summarizeFilter>[0]["period"];
  } = {},
): Parameters<typeof summarizeFilter>[0] {
  return {
    filter,
    // `period` can be `null` explicitly (caller wants "no period"),
    // so distinguish a missing key from an explicit null.
    period: "period" in overrides ? (overrides.period ?? null) : "1h",
    endpoints: overrides.endpoints ?? [],
    pivotOnly: overrides.pivotOnly ?? {},
    sensorOptions: SENSOR_OPTIONS,
    drawerOptions: DRAWER_OPTIONS,
  };
}

function sensorChips(chips: FilterChipSpec[]): FilterChipSpec[] {
  return chips.filter((chip) => chip.kind === "sensor");
}

describe("summarizeFilter", () => {
  it("emits the period summary when no other filter is active", () => {
    const { timeSummary, hasTimeChip, chips } = summarizeFilter(
      context(structured()),
      LABELS,
    );
    expect(timeSummary).toBe("Last 1 hour");
    expect(hasTimeChip).toBe(true);
    expect(chips).toEqual([]);
  });

  it("returns no chips when the filter has no sensor IDs", () => {
    const withNoSensors = summarizeFilter(context(structured({})), LABELS);
    expect(sensorChips(withNoSensors.chips)).toEqual([]);
    const emptyArray = summarizeFilter(
      context(structured({ sensors: [] })),
      LABELS,
    );
    expect(sensorChips(emptyArray.chips)).toEqual([]);
  });

  it("renders one sensor chip per ID for 1–3 selections", () => {
    const { chips } = summarizeFilter(
      context(structured({ sensors: ["sensor-a", "sensor-b", "sensor-c"] })),
      LABELS,
    );
    const names = sensorChips(chips).map((chip) =>
      chip.kind === "sensor" ? chip.value : "",
    );
    expect(names).toEqual(["Alpha", "Bravo", "Charlie"]);
    for (const chip of sensorChips(chips)) {
      if (chip.kind !== "sensor") throw new Error("unexpected chip kind");
      expect(chip.aggregate).toBe(false);
      expect(chip.sensorId).not.toBeNull();
    }
  });

  it("collapses four or more sensors to a single aggregate chip", () => {
    const { chips } = summarizeFilter(
      context(
        structured({
          sensors: ["sensor-a", "sensor-b", "sensor-c", "sensor-d"],
        }),
      ),
      LABELS,
    );
    const sensors = sensorChips(chips);
    expect(sensors).toHaveLength(1);
    const only = sensors[0];
    if (only?.kind !== "sensor") throw new Error("expected sensor chip");
    expect(only.aggregate).toBe(true);
    expect(only.value).toBe("4 selected");
    expect(only.sensorId).toBeNull();
  });

  it("falls back to the raw sensor ID when no option matches (cache miss)", () => {
    // A committed filter whose sensor is no longer in the session
    // options cache must still surface as a chip — silently dropping
    // the filter would mislead the operator about what is in effect.
    const { chips } = summarizeFilter(
      context(structured({ sensors: ["sensor-unknown"] })),
      LABELS,
    );
    const only = sensorChips(chips)[0];
    if (only?.kind !== "sensor") throw new Error("expected sensor chip");
    expect(only.value).toBe("sensor-unknown");
  });

  it("emits no per-field chips in query mode (forward-compat)", () => {
    // Query-mode filters cannot be decomposed into per-field chips;
    // the chip bar falls back to an empty set until the dedicated
    // single-pill renderer lands (see Phase Detection-9 forward-
    // compatibility note).
    const { chips, hasTimeChip, timeSummary } = summarizeFilter(
      context({ mode: "query", text: "ip:1.1.1.1 OR regex:/foo/" }),
      LABELS,
    );
    expect(chips).toEqual([]);
    expect(hasTimeChip).toBe(false);
    expect(timeSummary).toBe("No filter applied.");
  });

  it("keeps emitting non-time chips after the period has been cleared", () => {
    // Regression anchor for the round-7 reviewer concern: after the
    // Period chip is removed, `hasTimeChip` drops to false but the
    // remaining filter fields must still surface as chips. Without
    // this, the chip bar would lie about the active filter once any
    // other chip is left standing.
    const { chips, hasTimeChip } = summarizeFilter(
      context(
        {
          mode: "structured",
          input: { source: "10.0.0.5" },
        },
        { period: null },
      ),
      LABELS,
    );
    expect(hasTimeChip).toBe(false);
    const source = chips.find(
      (chip) => chip.kind === "pivot" && chip.field === "source",
    );
    expect(source).toBeDefined();
  });

  it("the individual-chip cap is 3", () => {
    expect(CHIP_DIMENSION_CAP).toBe(3);
  });

  it("emits a confidence chip only when the range is non-default", () => {
    const defaultRange = summarizeFilter(
      context(structured({ confidenceMin: 0, confidenceMax: 1 })),
      LABELS,
    );
    expect(defaultRange.chips.some((chip) => chip.kind === "confidence")).toBe(
      false,
    );
    const narrowed = summarizeFilter(
      context(structured({ confidenceMin: 0.7, confidenceMax: 1 })),
      LABELS,
    );
    const confidence = narrowed.chips.find(
      (chip) => chip.kind === "confidence",
    );
    expect(confidence).toBeDefined();
    if (confidence?.kind !== "confidence")
      throw new Error("expected confidence chip");
    expect(confidence.value).toBe("0.70 – 1.00");
  });

  it("emits direction chips only when the set is a strict subset", () => {
    const all = summarizeFilter(
      context(structured({ directions: ["OUTBOUND", "INTERNAL", "INBOUND"] })),
      LABELS,
    );
    expect(all.chips.some((chip) => chip.kind === "direction")).toBe(false);
    const subset = summarizeFilter(
      context(structured({ directions: ["OUTBOUND"] })),
      LABELS,
    );
    const direction = subset.chips.find((chip) => chip.kind === "direction");
    if (direction?.kind !== "direction") {
      throw new Error("expected direction chip");
    }
    expect(direction.flow).toBe("OUTBOUND");
  });

  it("renders a pivot chip for a single-value source IP", () => {
    const { chips } = summarizeFilter(
      context(structured({ source: "10.0.0.5" })),
      LABELS,
    );
    const source = chips.find(
      (chip) => chip.kind === "pivot" && chip.field === "source",
    );
    if (source?.kind !== "pivot") throw new Error("expected pivot chip");
    expect(source.value).toBe("10.0.0.5");
    expect(source.aggregate).toBe(false);
  });

  it("aggregates tag-field values past the per-dimension cap", () => {
    const { chips } = summarizeFilter(
      context(
        structured({
          keywords: ["a", "b", "c", "d", "e"],
        }),
      ),
      LABELS,
    );
    const aggregate = chips.find(
      (chip) => chip.kind === "pivot" && chip.field === "keywords",
    );
    if (aggregate?.kind !== "pivot") throw new Error("expected pivot chip");
    expect(aggregate.aggregate).toBe(true);
    expect(aggregate.value).toBe("Keywords: 5");
  });

  it("emits a multi-select chip for each selected level (below the cap)", () => {
    const { chips } = summarizeFilter(
      context(structured({ levels: [1, 2] })),
      LABELS,
    );
    const levels = chips.filter(
      (chip) => chip.kind === "multiSelect" && chip.fieldKey === "levels",
    );
    expect(levels).toHaveLength(2);
    expect(
      levels.every((chip) =>
        chip.kind === "multiSelect" ? chip.aggregate === false : false,
      ),
    ).toBe(true);
  });

  it("falls back to the empty-state label when neither period nor time range is set", () => {
    const { timeSummary, hasTimeChip } = summarizeFilter(
      context({ mode: "structured", input: {} }, { period: null }),
      LABELS,
    );
    expect(timeSummary).toBe("No filter applied.");
    expect(hasTimeChip).toBe(false);
  });

  it("prefers the period label when a period is committed even without explicit start/end", () => {
    const { timeSummary, hasTimeChip } = summarizeFilter(
      context({ mode: "structured", input: {} }, { period: "1d" }),
      LABELS,
    );
    expect(timeSummary).toBe("Last 1 day");
    // Without explicit start/end the period is informational — the
    // chip bar still can't render a `Period` chip because the
    // removable time window isn't present on the filter.
    expect(hasTimeChip).toBe(false);
  });
});
