import { describe, expect, it } from "vitest";

import {
  buildEndpointChips,
  type EndpointChipLabels,
  type EndpointEntry,
  type EndpointInput,
  endpointEntriesFromEndpointInputs,
  endpointsToEndpointInputs,
  parseEndpointInput,
  preservePredefinedEndpointInputs,
} from "@/lib/detection";

const CHIP_LABELS: EndpointChipLabels = {
  source: "Src",
  destination: "Dst",
  aggregate: "Network: {count} rules",
};

function entry(overrides: Partial<EndpointEntry>): EndpointEntry {
  return {
    id: "x",
    raw: "10.0.0.1",
    kind: "host",
    host: "10.0.0.1",
    direction: "BOTH",
    selected: true,
    ...overrides,
  };
}

describe("parseEndpointInput", () => {
  it("parses a single IPv4 as host", () => {
    expect(parseEndpointInput("10.84.1.7")).toEqual({
      kind: "host",
      host: "10.84.1.7",
    });
  });

  it("parses an IP range", () => {
    expect(parseEndpointInput("10.1.1.1 - 10.1.1.20")).toEqual({
      kind: "range",
      range: { start: "10.1.1.1", end: "10.1.1.20" },
    });
  });

  it("tolerates whitespace around the range hyphen", () => {
    expect(parseEndpointInput("10.1.1.1-10.1.1.20")).toEqual({
      kind: "range",
      range: { start: "10.1.1.1", end: "10.1.1.20" },
    });
  });

  it("parses a CIDR as network", () => {
    expect(parseEndpointInput("192.168.10.0/24")).toEqual({
      kind: "network",
      network: "192.168.10.0/24",
    });
  });

  it("rejects invalid formats", () => {
    expect(parseEndpointInput("")).toBeNull();
    expect(parseEndpointInput("not-an-ip")).toBeNull();
    expect(parseEndpointInput("10.0.0")).toBeNull();
    expect(parseEndpointInput("10.0.0.256")).toBeNull();
    expect(parseEndpointInput("10.0.0.01")).toBeNull(); // leading zero
    expect(parseEndpointInput("10.0.0.1/33")).toBeNull(); // prefix too big
    expect(parseEndpointInput("10.0.0.1 - 9.0.0.0")).toBeNull(); // inverted
    expect(parseEndpointInput("10.0.0.1 - 10.0.0.2 - 10.0.0.3")).toBeNull();
  });

  it("rejects IPv6 in v1", () => {
    expect(parseEndpointInput("::1")).toBeNull();
    expect(parseEndpointInput("2001:db8::1")).toBeNull();
  });
});

describe("endpointsToEndpointInputs", () => {
  it("groups entries by direction into one EndpointInput each", () => {
    const entries: EndpointEntry[] = [
      entry({ id: "1", raw: "10.0.0.1", direction: "SOURCE" }),
      entry({
        id: "2",
        raw: "10.0.0.0/24",
        kind: "network",
        host: undefined,
        network: "10.0.0.0/24",
        direction: "BOTH",
      }),
      entry({
        id: "3",
        raw: "10.1.1.1 - 10.1.1.20",
        kind: "range",
        host: undefined,
        range: { start: "10.1.1.1", end: "10.1.1.20" },
        direction: "DESTINATION",
      }),
    ];
    const result = endpointsToEndpointInputs(entries);
    expect(result).toEqual([
      {
        direction: null,
        custom: {
          hosts: [],
          networks: ["10.0.0.0/24"],
          ranges: [],
        },
      },
      {
        direction: "FROM",
        custom: {
          hosts: ["10.0.0.1"],
          networks: [],
          ranges: [],
        },
      },
      {
        direction: "TO",
        custom: {
          hosts: [],
          networks: [],
          ranges: [{ start: "10.1.1.1", end: "10.1.1.20" }],
        },
      },
    ]);
  });

  it("omits deselected entries", () => {
    const entries: EndpointEntry[] = [
      entry({ id: "1", raw: "10.0.0.1", host: "10.0.0.1", selected: false }),
      entry({
        id: "2",
        raw: "10.0.0.2",
        host: "10.0.0.2",
        direction: "SOURCE",
      }),
    ];
    expect(endpointsToEndpointInputs(entries)).toEqual([
      {
        direction: "FROM",
        custom: { hosts: ["10.0.0.2"], networks: [], ranges: [] },
      },
    ]);
  });

  it("returns empty array when nothing is selected", () => {
    const entries: EndpointEntry[] = [
      entry({ id: "1", raw: "10.0.0.1", host: "10.0.0.1", selected: false }),
    ];
    expect(endpointsToEndpointInputs(entries)).toEqual([]);
  });

  it("uses long-form direction constants — never abbreviates", () => {
    // Regression: terminology is Both/Source/Destination; the wire
    // format is FROM/TO/null. Never SRC/DST.
    const entries: EndpointEntry[] = [
      entry({
        id: "1",
        raw: "10.0.0.1",
        host: "10.0.0.1",
        direction: "SOURCE",
      }),
      entry({
        id: "2",
        raw: "10.0.0.2",
        host: "10.0.0.2",
        direction: "DESTINATION",
      }),
    ];
    const result = endpointsToEndpointInputs(entries);
    expect(result.map((e) => e.direction)).toEqual(["FROM", "TO"]);
  });
});

describe("endpointEntriesFromEndpointInputs", () => {
  it("expands hosts/networks/ranges back into one selected entry per rule", () => {
    const entries = endpointEntriesFromEndpointInputs([
      {
        direction: "FROM",
        custom: {
          hosts: ["10.0.0.1"],
          networks: ["10.0.0.0/24"],
          ranges: [{ start: "10.1.1.1", end: "10.1.1.20" }],
        },
      },
      {
        direction: "TO",
        custom: { hosts: ["10.0.0.2"], networks: [], ranges: [] },
      },
      {
        direction: null,
        custom: { hosts: ["10.0.0.3"], networks: [], ranges: [] },
      },
    ]);
    expect(entries).toHaveLength(5);
    expect(entries.every((e) => e.selected)).toBe(true);
    expect(
      entries.map((e) => ({ kind: e.kind, direction: e.direction })),
    ).toEqual([
      { kind: "host", direction: "SOURCE" },
      { kind: "network", direction: "SOURCE" },
      { kind: "range", direction: "SOURCE" },
      { kind: "host", direction: "DESTINATION" },
      { kind: "host", direction: "BOTH" },
    ]);
    const range = entries[2];
    expect(range.range).toEqual({ start: "10.1.1.1", end: "10.1.1.20" });
    expect(range.raw).toBe("10.1.1.1 - 10.1.1.20");
  });

  it("round-trips through endpointsToEndpointInputs without losing rules", () => {
    const inputs: EndpointInput[] = [
      {
        direction: null,
        custom: { hosts: ["10.0.0.0"], networks: ["10.0.0.0/24"], ranges: [] },
      },
      {
        direction: "FROM",
        custom: {
          hosts: [],
          networks: [],
          ranges: [{ start: "10.1.1.1", end: "10.1.1.20" }],
        },
      },
      {
        direction: "TO",
        custom: { hosts: ["10.0.0.9"], networks: [], ranges: [] },
      },
    ];
    const rebuilt = endpointsToEndpointInputs(
      endpointEntriesFromEndpointInputs(inputs),
    );
    expect(rebuilt).toEqual(inputs);
  });

  it("skips predefined-only entries since the EndpointEntry mirror has no shape for them", () => {
    const entries = endpointEntriesFromEndpointInputs([
      { direction: null, predefined: "predefined-id" },
    ]);
    expect(entries).toEqual([]);
  });

  it("handles a null/undefined input safely", () => {
    expect(endpointEntriesFromEndpointInputs(null)).toEqual([]);
    expect(endpointEntriesFromEndpointInputs(undefined)).toEqual([]);
    expect(endpointEntriesFromEndpointInputs([])).toEqual([]);
  });
});

describe("preservePredefinedEndpointInputs", () => {
  it("extracts predefined-only entries with their direction", () => {
    expect(
      preservePredefinedEndpointInputs([
        { direction: "FROM", predefined: "net-1" },
        { direction: null, predefined: "net-2" },
      ]),
    ).toEqual([
      { direction: "FROM", predefined: "net-1" },
      { direction: null, predefined: "net-2" },
    ]);
  });

  it("strips co-located custom payload so the mirror does not double-count rules", () => {
    expect(
      preservePredefinedEndpointInputs([
        {
          direction: "TO",
          predefined: "net-1",
          custom: { hosts: ["10.0.0.1"], networks: [], ranges: [] },
        },
      ]),
    ).toEqual([{ direction: "TO", predefined: "net-1" }]);
  });

  it("skips custom-only and empty / nullish entries", () => {
    expect(
      preservePredefinedEndpointInputs([
        {
          direction: "FROM",
          custom: { hosts: ["10.0.0.1"], networks: [], ranges: [] },
        },
        { direction: null, predefined: "" },
      ]),
    ).toEqual([]);
    expect(preservePredefinedEndpointInputs(null)).toEqual([]);
    expect(preservePredefinedEndpointInputs(undefined)).toEqual([]);
    expect(preservePredefinedEndpointInputs([])).toEqual([]);
  });
});

describe("buildEndpointChips", () => {
  it("emits no chips when no selected entries", () => {
    expect(
      buildEndpointChips([entry({ id: "1", selected: false })], CHIP_LABELS),
    ).toEqual([]);
  });

  it("emits one chip per entry for 1–3 selected entries", () => {
    const entries: EndpointEntry[] = [
      entry({ id: "1", raw: "10.0.0.5", direction: "SOURCE" }),
      entry({
        id: "2",
        raw: "10.0.0.0/24",
        kind: "network",
        host: undefined,
        network: "10.0.0.0/24",
        direction: "DESTINATION",
      }),
      entry({ id: "3", raw: "10.0.0.6", direction: "BOTH" }),
    ];
    const chips = buildEndpointChips(entries, CHIP_LABELS);
    expect(chips).toEqual([
      { id: "1", label: "Src 10.0.0.5", aggregate: false },
      { id: "2", label: "Dst 10.0.0.0/24", aggregate: false },
      { id: "3", label: "10.0.0.6", aggregate: false },
    ]);
  });

  it("collapses into a single aggregate chip when more than 3 entries are selected", () => {
    const entries: EndpointEntry[] = Array.from({ length: 5 }, (_, i) =>
      entry({
        id: `${i}`,
        raw: `10.0.0.${i + 1}`,
        host: `10.0.0.${i + 1}`,
      }),
    );
    const chips = buildEndpointChips(entries, CHIP_LABELS);
    expect(chips).toEqual([
      { id: "endpoint-aggregate", label: "Network: 5 rules", aggregate: true },
    ]);
  });

  it("does not count deselected entries toward the aggregation threshold", () => {
    const entries: EndpointEntry[] = [
      ...Array.from({ length: 3 }, (_, i) =>
        entry({
          id: `sel-${i}`,
          raw: `10.0.0.${i + 1}`,
          host: `10.0.0.${i + 1}`,
        }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        entry({
          id: `ds-${i}`,
          raw: `10.0.0.${i + 100}`,
          host: `10.0.0.${i + 100}`,
          selected: false,
        }),
      ),
    ];
    const chips = buildEndpointChips(entries, CHIP_LABELS);
    expect(chips).toHaveLength(3);
    expect(chips.every((c) => !c.aggregate)).toBe(true);
  });
});
