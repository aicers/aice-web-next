import { describe, expect, it } from "vitest";

import {
  hasAnyActiveChip,
  removeActiveChip,
} from "@/lib/detection/active-filters";
import type { EndpointEntry } from "@/lib/detection/endpoint-filter";
import type { Filter } from "@/lib/detection/filter";

const baseFilter: Filter = {
  mode: "structured",
  input: {
    start: "2026-04-22T00:00:00.000Z",
    end: "2026-04-22T01:00:00.000Z",
  },
};

describe("removeActiveChip", () => {
  it("removes a scalar field (source/destination)", () => {
    const filter: Filter = {
      mode: "structured",
      input: { ...baseFilter.input, source: "10.0.0.5" },
    };
    const result = removeActiveChip(filter, [], {
      kind: "scalarField",
      field: "source",
    });
    if (result.filter.mode !== "structured") throw new Error("unreachable");
    expect(result.filter.input.source).toBeUndefined();
  });

  it("removes a single value from an array field, leaving the rest", () => {
    const filter: Filter = {
      mode: "structured",
      input: { ...baseFilter.input, keywords: ["a", "b", "c"] },
    };
    const result = removeActiveChip(filter, [], {
      kind: "arrayValue",
      field: "keywords",
      value: "b",
    });
    if (result.filter.mode !== "structured") throw new Error("unreachable");
    expect(result.filter.input.keywords).toEqual(["a", "c"]);
  });

  it("drops the array field entirely when the last value is removed", () => {
    const filter: Filter = {
      mode: "structured",
      input: { ...baseFilter.input, keywords: ["only"] },
    };
    const result = removeActiveChip(filter, [], {
      kind: "arrayValue",
      field: "keywords",
      value: "only",
    });
    if (result.filter.mode !== "structured") throw new Error("unreachable");
    expect(result.filter.input.keywords).toBeUndefined();
  });

  it("drops the entire array field on aggregate removal", () => {
    const filter: Filter = {
      mode: "structured",
      input: {
        ...baseFilter.input,
        sensors: ["s1", "s2", "s3", "s4"],
      },
    };
    const result = removeActiveChip(filter, [], {
      kind: "arrayAggregate",
      field: "sensors",
    });
    if (result.filter.mode !== "structured") throw new Error("unreachable");
    expect(result.filter.input.sensors).toBeUndefined();
  });

  it("removes a single categorical value (numeric)", () => {
    const filter: Filter = {
      mode: "structured",
      input: { ...baseFilter.input, levels: [1, 2] },
    };
    const result = removeActiveChip(filter, [], {
      kind: "categoricalValue",
      field: "levels",
      value: 1,
    });
    if (result.filter.mode !== "structured") throw new Error("unreachable");
    expect(result.filter.input.levels).toEqual([2]);
  });

  it("removes a single direction value, falling back to no-filter when emptied", () => {
    const filter: Filter = {
      mode: "structured",
      input: { ...baseFilter.input, directions: ["INBOUND"] },
    };
    const result = removeActiveChip(filter, [], {
      kind: "directionValue",
      value: "INBOUND",
    });
    if (result.filter.mode !== "structured") throw new Error("unreachable");
    // Removing the last selected direction would leave the set empty
    // (= no rows). The drawer's invariant says "no direction filter"
    // is the right fallback — the helper drops the field entirely.
    expect(result.filter.input.directions).toBeUndefined();
  });

  it("removes confidence min/max in one shot", () => {
    const filter: Filter = {
      mode: "structured",
      input: { ...baseFilter.input, confidenceMin: 0.5, confidenceMax: 0.9 },
    };
    const result = removeActiveChip(filter, [], { kind: "confidence" });
    if (result.filter.mode !== "structured") throw new Error("unreachable");
    expect(result.filter.input.confidenceMin).toBeUndefined();
    expect(result.filter.input.confidenceMax).toBeUndefined();
  });

  it("removes a single endpoint entry by id", () => {
    const e1: EndpointEntry = {
      id: "ep-1",
      raw: "10.0.0.5",
      kind: "host",
      host: "10.0.0.5",
      direction: "BOTH",
      selected: true,
    };
    const e2: EndpointEntry = {
      id: "ep-2",
      raw: "192.168.1.0/24",
      kind: "network",
      network: "192.168.1.0/24",
      direction: "SOURCE",
      selected: true,
    };
    const result = removeActiveChip(baseFilter, [e1, e2], {
      kind: "endpointEntry",
      entryId: "ep-1",
    });
    expect(result.endpoints).toEqual([e2]);
  });

  it("clears every endpoint entry on aggregate removal", () => {
    const e1: EndpointEntry = {
      id: "ep-1",
      raw: "10.0.0.5",
      kind: "host",
      host: "10.0.0.5",
      direction: "BOTH",
      selected: true,
    };
    const result = removeActiveChip(baseFilter, [e1], { kind: "endpointAll" });
    expect(result.endpoints).toEqual([]);
  });

  it("clears query text on queryPill removal", () => {
    const filter: Filter = { mode: "query", text: "level:HIGH" };
    const result = removeActiveChip(filter, [], { kind: "queryPill" });
    if (result.filter.mode !== "query") throw new Error("unreachable");
    expect(result.filter.text).toBe("");
  });

  it("is a no-op for non-query targets in query mode", () => {
    const filter: Filter = { mode: "query", text: "anything" };
    const result = removeActiveChip(filter, [], { kind: "confidence" });
    expect(result.filter).toBe(filter);
  });
});

describe("hasAnyActiveChip", () => {
  it("returns false for a filter that only carries time bounds", () => {
    expect(hasAnyActiveChip(baseFilter)).toBe(false);
  });

  it("returns true when any non-time field is set", () => {
    const filter: Filter = {
      mode: "structured",
      input: { ...baseFilter.input, source: "10.0.0.5" },
    };
    expect(hasAnyActiveChip(filter)).toBe(true);
  });

  it("returns true for a non-empty query string in query mode", () => {
    expect(hasAnyActiveChip({ mode: "query", text: "x" })).toBe(true);
    expect(hasAnyActiveChip({ mode: "query", text: "  " })).toBe(false);
  });
});
