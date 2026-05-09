import { describe, expect, it } from "vitest";

import {
  DetectionNotImplementedError,
  type Filter,
  toEventListFilterInput,
} from "@/lib/detection";

describe("toEventListFilterInput", () => {
  it("returns the structured input unchanged", () => {
    const filter: Filter = {
      mode: "structured",
      input: {
        start: "2026-04-01T00:00:00Z",
        end: "2026-04-02T00:00:00Z",
        levels: ["LOW", "MEDIUM"],
        kinds: ["PortScan"],
      },
    };

    expect(toEventListFilterInput(filter)).toEqual({
      start: "2026-04-01T00:00:00Z",
      end: "2026-04-02T00:00:00Z",
      levels: ["LOW", "MEDIUM"],
      kinds: ["PortScan"],
    });
  });

  it("passes caller-supplied `customers` through as a query dimension", () => {
    // `customers` is part of the query surface — callers can narrow
    // to a subset of their allowed scope. Authorization lives in the
    // Context JWT attached by `graphqlRequest`, not in the filter.
    const filter: Filter = {
      mode: "structured",
      input: {
        start: "2026-04-01T00:00:00Z",
        end: "2026-04-02T00:00:00Z",
        customers: ["99"],
      },
    };

    expect(toEventListFilterInput(filter)).toEqual({
      start: "2026-04-01T00:00:00Z",
      end: "2026-04-02T00:00:00Z",
      customers: ["99"],
    });
  });

  it('throws DetectionNotImplementedError for mode "query"', () => {
    const filter: Filter = { mode: "query", text: "ip:1.1.1.1" };
    expect(() => toEventListFilterInput(filter)).toThrow(
      DetectionNotImplementedError,
    );
  });
});
