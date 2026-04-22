import { describe, expect, it } from "vitest";

import type { Filter } from "@/lib/detection/filter";
import {
  type ChipSpec,
  MAX_INDIVIDUAL_VALUES,
  removeChipFromFilter,
  type SummarizeFilterLabels,
  summarizeFilter,
} from "@/lib/detection/summarize-filter";
import type { ThreatLevel } from "@/lib/detection/types";

const labels: SummarizeFilterLabels = {
  period: "Period",
  range: "Range",
  source: "Source",
  destination: "Destination",
  confidenceMin: "Min confidence",
  confidenceMax: "Max confidence",
  customers: "Customers",
  endpoints: "Endpoints",
  directions: "Direction",
  keywords: "Keywords",
  networkTags: "Network tags",
  sensors: "Sensors",
  os: "OS",
  devices: "Devices",
  hostnames: "Hostnames",
  userIds: "User IDs",
  userNames: "User names",
  userDepartments: "User departments",
  countries: "Countries",
  categories: "Categories",
  levels: "Severity",
  kinds: "Kind",
  learningMethods: "Learning method",
  triagePolicies: "Triage policies",
  periodOptions: { "1h": "Last 1 hour" },
  rangeFormatter: (s, e) => `${s}…${e}`,
  levelName: (l: ThreatLevel) => l,
  aggregate: (count) => `${count} selected`,
};

describe("summarizeFilter", () => {
  it("returns empty list for query mode (forward-compat)", () => {
    const filter: Filter = { mode: "query", text: "foo" };
    expect(summarizeFilter(filter, labels)).toEqual([]);
  });

  it("renders a Period chip when start/end match a quick-select", () => {
    const filter: Filter = {
      mode: "structured",
      input: {
        start: "2026-04-22T11:00:00.000Z",
        end: "2026-04-22T12:00:00.000Z",
      },
    };
    const chips = summarizeFilter(filter, labels, { matchedPeriod: "1h" });
    expect(chips[0]).toMatchObject({
      field: "period",
      kind: "value",
      label: "Period",
      value: "Last 1 hour",
    });
  });

  it("renders a Range chip when no period key matches", () => {
    const filter: Filter = {
      mode: "structured",
      input: {
        start: "2026-04-22T01:23:00.000Z",
        end: "2026-04-22T03:45:00.000Z",
      },
    };
    const chips = summarizeFilter(filter, labels);
    expect(chips[0]).toMatchObject({ field: "range", kind: "value" });
    expect(chips[0].value).toContain("…");
  });

  it("emits per-value chips for arrays at or below the threshold", () => {
    const filter: Filter = {
      mode: "structured",
      input: { hostnames: ["a", "b", "c"] },
    };
    const chips = summarizeFilter(filter, labels);
    expect(chips.length).toBe(MAX_INDIVIDUAL_VALUES);
    chips.forEach((chip, i) => {
      expect(chip.kind).toBe("value");
      expect(chip.field).toBe("hostnames");
      expect(chip.value).toBe(["a", "b", "c"][i]);
      expect(chip.arrayIndex).toBe(i);
    });
  });

  it("collapses arrays larger than the threshold into a single aggregate chip", () => {
    const filter: Filter = {
      mode: "structured",
      input: { hostnames: ["a", "b", "c", "d"] },
    };
    const chips = summarizeFilter(filter, labels);
    expect(chips).toEqual<ChipSpec[]>([
      {
        id: "hostnames",
        field: "hostnames",
        kind: "aggregate",
        label: "Hostnames",
        value: "4 selected",
        values: ["a", "b", "c", "d"],
      },
    ]);
  });

  it("formats levels via the levelName lookup", () => {
    const filter: Filter = {
      mode: "structured",
      input: { levels: [3, 2] },
    };
    const chips = summarizeFilter(filter, labels);
    expect(chips.map((c) => c.value)).toEqual(["HIGH", "MEDIUM"]);
  });

  it("renders confidence min/max as fixed-precision values", () => {
    const filter: Filter = {
      mode: "structured",
      input: { confidenceMin: 0.5, confidenceMax: 0.95 },
    };
    const chips = summarizeFilter(filter, labels);
    expect(chips.map((c) => c.value)).toEqual(["0.50", "0.95"]);
  });

  it("emits per-rule endpoint chips when at or below the threshold", () => {
    const filter: Filter = {
      mode: "structured",
      input: {
        endpoints: [
          { direction: "FROM", predefined: "1" },
          { direction: "TO", predefined: "2" },
        ],
      },
    };
    const chips = summarizeFilter(filter, labels);
    expect(chips).toEqual<ChipSpec[]>([
      {
        id: "endpoints:0",
        field: "endpoints",
        kind: "value",
        label: "Endpoints",
        value: "FROM · #1",
        arrayIndex: 0,
      },
      {
        id: "endpoints:1",
        field: "endpoints",
        kind: "value",
        label: "Endpoints",
        value: "TO · #2",
        arrayIndex: 1,
      },
    ]);
  });

  it("collapses endpoint arrays larger than the threshold into a single aggregate chip", () => {
    const filter: Filter = {
      mode: "structured",
      input: {
        endpoints: [
          { direction: "FROM", predefined: "1" },
          { direction: "TO", predefined: "2" },
          { direction: "FROM", predefined: "3" },
          { direction: "TO", predefined: "4" },
        ],
      },
    };
    const chips = summarizeFilter(filter, labels);
    expect(chips).toEqual<ChipSpec[]>([
      {
        id: "endpoints",
        field: "endpoints",
        kind: "aggregate",
        label: "Endpoints",
        value: "4 selected",
        values: ["FROM · #1", "TO · #2", "FROM · #3", "TO · #4"],
      },
    ]);
  });

  it("renders a custom endpoint rule as a comma-joined host/network/range list", () => {
    const filter: Filter = {
      mode: "structured",
      input: {
        endpoints: [
          {
            direction: "TO",
            custom: {
              hosts: ["10.0.0.5"],
              networks: ["10.0.0.0/24"],
              ranges: [{ start: "10.0.1.1", end: "10.0.1.9" }],
            },
          },
        ],
      },
    };
    const chips = summarizeFilter(filter, labels);
    expect(chips[0].value).toBe(
      "TO · 10.0.0.5, 10.0.0.0/24, 10.0.1.1–10.0.1.9",
    );
  });
});

describe("removeChipFromFilter", () => {
  const chip = (overrides: Partial<ChipSpec>): ChipSpec => ({
    id: "x",
    field: "kinds",
    kind: "value",
    label: "Kind",
    value: "HttpThreat",
    ...overrides,
  });

  it("clears start and end when the period or range chip is removed", () => {
    const filter: Filter = {
      mode: "structured",
      input: {
        start: "2026-04-22T11:00:00.000Z",
        end: "2026-04-22T12:00:00.000Z",
        source: "10.0.0.5",
      },
    };
    const next = removeChipFromFilter(
      filter,
      chip({ field: "period", id: "period" }),
    );
    expect(next).toEqual<Filter>({
      mode: "structured",
      input: { source: "10.0.0.5" },
    });
  });

  it("removes a single array entry by index", () => {
    const filter: Filter = {
      mode: "structured",
      input: { hostnames: ["a", "b", "c"] },
    };
    const next = removeChipFromFilter(
      filter,
      chip({
        field: "hostnames",
        kind: "value",
        value: "b",
        arrayIndex: 1,
        id: "hostnames:1",
      }),
    );
    expect(next).toEqual<Filter>({
      mode: "structured",
      input: { hostnames: ["a", "c"] },
    });
  });

  it("drops the array field entirely when the last entry is removed", () => {
    const filter: Filter = {
      mode: "structured",
      input: { hostnames: ["only"] },
    };
    const next = removeChipFromFilter(
      filter,
      chip({
        field: "hostnames",
        kind: "value",
        value: "only",
        arrayIndex: 0,
        id: "hostnames:0",
      }),
    );
    expect(next).toEqual<Filter>({
      mode: "structured",
      input: {},
    });
  });

  it("removes the entire array when an aggregate chip is removed", () => {
    const filter: Filter = {
      mode: "structured",
      input: { hostnames: ["a", "b", "c", "d", "e"] },
    };
    const next = removeChipFromFilter(
      filter,
      chip({
        field: "hostnames",
        kind: "aggregate",
        value: "5 selected",
        id: "hostnames",
      }),
    );
    expect(next).toEqual<Filter>({
      mode: "structured",
      input: {},
    });
  });

  it("removes a single endpoint rule by index", () => {
    const filter: Filter = {
      mode: "structured",
      input: {
        endpoints: [
          { direction: "FROM", predefined: "1" },
          { direction: "TO", predefined: "2" },
        ],
      },
    };
    const next = removeChipFromFilter(
      filter,
      chip({
        field: "endpoints",
        kind: "value",
        value: "TO · #2",
        arrayIndex: 1,
        id: "endpoints:1",
      }),
    );
    expect(next).toEqual<Filter>({
      mode: "structured",
      input: { endpoints: [{ direction: "FROM", predefined: "1" }] },
    });
  });

  it("removes the entire endpoints field when an aggregate chip is removed", () => {
    const filter: Filter = {
      mode: "structured",
      input: {
        endpoints: [
          { direction: "FROM", predefined: "1" },
          { direction: "TO", predefined: "2" },
          { direction: "FROM", predefined: "3" },
          { direction: "TO", predefined: "4" },
        ],
      },
    };
    const next = removeChipFromFilter(
      filter,
      chip({
        field: "endpoints",
        kind: "aggregate",
        value: "4 selected",
        id: "endpoints",
      }),
    );
    expect(next).toEqual<Filter>({ mode: "structured", input: {} });
  });

  it("never mutates the original filter", () => {
    const input = { hostnames: ["a", "b"] };
    const filter: Filter = { mode: "structured", input };
    removeChipFromFilter(
      filter,
      chip({
        field: "hostnames",
        kind: "value",
        value: "a",
        arrayIndex: 0,
        id: "hostnames:0",
      }),
    );
    expect(input).toEqual({ hostnames: ["a", "b"] });
  });

  it("returns the same filter when mode is query", () => {
    const filter: Filter = { mode: "query", text: "foo" };
    expect(
      removeChipFromFilter(
        filter,
        chip({ field: "source", kind: "value", id: "source" }),
      ),
    ).toBe(filter);
  });
});
