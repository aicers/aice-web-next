import { describe, expect, it } from "vitest";

import {
  buildDirectionChips,
  DEFAULT_DIRECTIONS,
  directionsForFilterInput,
  FLOW_KINDS,
  isAllDirections,
  normalizeDirections,
  readDirectionsFromInput,
  toggleDirection,
} from "@/lib/detection/direction";
import type { FlowKind } from "@/lib/detection/types";

const LABELS = {
  label: "Direction",
  values: {
    OUTBOUND: "Outbound",
    INTERNAL: "Internal",
    INBOUND: "Inbound",
  } as Record<FlowKind, string>,
} as const;

describe("FLOW_KINDS", () => {
  it("lists the three kinds in canonical order", () => {
    expect(FLOW_KINDS).toEqual(["OUTBOUND", "INTERNAL", "INBOUND"]);
  });

  it("DEFAULT_DIRECTIONS matches FLOW_KINDS", () => {
    expect(DEFAULT_DIRECTIONS).toEqual(FLOW_KINDS);
  });
});

describe("isAllDirections", () => {
  it("is true when every FlowKind is present", () => {
    expect(isAllDirections(["OUTBOUND", "INTERNAL", "INBOUND"])).toBe(true);
    // Order-insensitive.
    expect(isAllDirections(["INBOUND", "OUTBOUND", "INTERNAL"])).toBe(true);
  });

  it("is false when any FlowKind is missing", () => {
    expect(isAllDirections(["OUTBOUND", "INTERNAL"])).toBe(false);
    expect(isAllDirections([])).toBe(false);
  });
});

describe("toggleDirection", () => {
  it("adds a missing kind in canonical order", () => {
    expect(toggleDirection(["OUTBOUND"], "INBOUND")).toEqual([
      "OUTBOUND",
      "INBOUND",
    ]);
  });

  it("removes a present kind, keeping canonical order", () => {
    expect(
      toggleDirection(["OUTBOUND", "INTERNAL", "INBOUND"], "INTERNAL"),
    ).toEqual(["OUTBOUND", "INBOUND"]);
  });

  it("reverts to all three when deselecting the last remaining kind", () => {
    expect(toggleDirection(["INBOUND"], "INBOUND")).toEqual([
      "OUTBOUND",
      "INTERNAL",
      "INBOUND",
    ]);
  });

  it("normalizes input order regardless of insertion order", () => {
    expect(toggleDirection(["INBOUND", "OUTBOUND"], "INTERNAL")).toEqual([
      "OUTBOUND",
      "INTERNAL",
      "INBOUND",
    ]);
  });
});

describe("normalizeDirections", () => {
  it("reorders into canonical FLOW_KINDS order", () => {
    expect(normalizeDirections(["INBOUND", "OUTBOUND"])).toEqual([
      "OUTBOUND",
      "INBOUND",
    ]);
  });

  it("dedupes implicitly via FLOW_KINDS.filter", () => {
    expect(normalizeDirections(["INBOUND", "INBOUND", "OUTBOUND"])).toEqual([
      "OUTBOUND",
      "INBOUND",
    ]);
  });
});

describe("directionsForFilterInput", () => {
  it("returns undefined when all three are selected (no filter)", () => {
    expect(
      directionsForFilterInput(["OUTBOUND", "INTERNAL", "INBOUND"]),
    ).toBeUndefined();
  });

  it("returns undefined on empty/null/undefined", () => {
    expect(directionsForFilterInput([])).toBeUndefined();
    expect(directionsForFilterInput(null)).toBeUndefined();
    expect(directionsForFilterInput(undefined)).toBeUndefined();
  });

  it("returns a normalized array when some are selected", () => {
    expect(directionsForFilterInput(["INBOUND", "OUTBOUND"])).toEqual([
      "OUTBOUND",
      "INBOUND",
    ]);
  });
});

describe("readDirectionsFromInput", () => {
  it("returns all three when nothing was committed", () => {
    expect(readDirectionsFromInput(undefined)).toEqual([...FLOW_KINDS]);
    expect(readDirectionsFromInput(null)).toEqual([...FLOW_KINDS]);
    expect(readDirectionsFromInput([])).toEqual([...FLOW_KINDS]);
  });

  it("reorders a committed subset into canonical order", () => {
    expect(readDirectionsFromInput(["INBOUND", "OUTBOUND"])).toEqual([
      "OUTBOUND",
      "INBOUND",
    ]);
  });
});

describe("buildDirectionChips", () => {
  it("returns no chips when all are selected (no filter)", () => {
    expect(
      buildDirectionChips(["OUTBOUND", "INTERNAL", "INBOUND"], LABELS),
    ).toEqual([]);
  });

  it("returns no chips for empty/null/undefined", () => {
    expect(buildDirectionChips([], LABELS)).toEqual([]);
    expect(buildDirectionChips(null, LABELS)).toEqual([]);
    expect(buildDirectionChips(undefined, LABELS)).toEqual([]);
  });

  it("returns two chips when two are selected, in canonical order", () => {
    expect(buildDirectionChips(["INBOUND", "INTERNAL"], LABELS)).toEqual([
      { id: "direction:INTERNAL", label: "Direction", value: "Internal" },
      { id: "direction:INBOUND", label: "Direction", value: "Inbound" },
    ]);
  });

  it("returns one chip when a single kind is selected", () => {
    expect(buildDirectionChips(["INBOUND"], LABELS)).toEqual([
      { id: "direction:INBOUND", label: "Direction", value: "Inbound" },
    ]);
  });
});
