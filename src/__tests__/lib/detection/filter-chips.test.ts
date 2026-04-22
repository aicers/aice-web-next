import { describe, expect, it } from "vitest";

import {
  buildMultiSelectChips,
  selectionForSubmission,
} from "@/lib/detection/filter-chips";

const LEVEL_OPTIONS = [
  { value: 1, label: "Low" },
  { value: 2, label: "Medium" },
  { value: 3, label: "High" },
];

const COUNTRY_OPTIONS = Array.from({ length: 10 }, (_, i) => ({
  value: `C${i.toString().padStart(2, "0")}`,
  label: `Country ${i}`,
}));

const countLabel = (n: number) => `${n} selected`;

describe("buildMultiSelectChips — aggregation rule", () => {
  it("returns no chips when nothing is selected", () => {
    const chips = buildMultiSelectChips({
      fieldKey: "levels",
      fieldLabel: "Threat Level",
      options: LEVEL_OPTIONS,
      selected: [],
      aggregateValue: countLabel,
    });
    expect(chips).toEqual([]);
  });

  it("returns no chips when every option is selected (== no filter)", () => {
    const chips = buildMultiSelectChips({
      fieldKey: "levels",
      fieldLabel: "Threat Level",
      options: LEVEL_OPTIONS,
      selected: [1, 2, 3],
      aggregateValue: countLabel,
    });
    expect(chips).toEqual([]);
  });

  it("returns one chip per value when 1-3 are selected", () => {
    const chips = buildMultiSelectChips({
      fieldKey: "countries",
      fieldLabel: "Threat Country",
      options: COUNTRY_OPTIONS,
      selected: ["C00", "C01"],
      aggregateValue: countLabel,
    });
    expect(chips).toHaveLength(2);
    expect(chips[0]).toMatchObject({
      key: "countries:C00",
      fieldKey: "countries",
      label: "Threat Country",
      value: "Country 0",
      aggregate: false,
    });
    expect(chips[1]).toMatchObject({ value: "Country 1", aggregate: false });
  });

  it("returns exactly 3 individual chips when 3 are selected", () => {
    const chips = buildMultiSelectChips({
      fieldKey: "countries",
      fieldLabel: "Threat Country",
      options: COUNTRY_OPTIONS,
      selected: ["C00", "C01", "C02"],
      aggregateValue: countLabel,
    });
    expect(chips).toHaveLength(3);
    expect(chips.every((c) => !c.aggregate)).toBe(true);
  });

  it("collapses to a single aggregate chip when more than 3 are selected", () => {
    const chips = buildMultiSelectChips({
      fieldKey: "countries",
      fieldLabel: "Threat Country",
      options: COUNTRY_OPTIONS,
      selected: ["C00", "C01", "C02", "C03"],
      aggregateValue: countLabel,
    });
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({
      key: "countries:__agg",
      aggregate: true,
      label: "Threat Country",
      value: "4 selected",
    });
  });

  it("uses the value's declared label when chip is individual", () => {
    const chips = buildMultiSelectChips({
      fieldKey: "levels",
      fieldLabel: "Threat Level",
      options: LEVEL_OPTIONS,
      selected: [2],
      aggregateValue: countLabel,
    });
    expect(chips).toEqual([
      {
        key: "levels:2",
        fieldKey: "levels",
        label: "Threat Level",
        value: "Medium",
        aggregate: false,
      },
    ]);
  });
});

describe("selectionForSubmission — 'all or none omits the field'", () => {
  it("returns null for an empty selection", () => {
    expect(selectionForSubmission([], LEVEL_OPTIONS)).toBeNull();
  });

  it("returns null when every option is selected", () => {
    expect(selectionForSubmission([1, 2, 3], LEVEL_OPTIONS)).toBeNull();
  });

  it("returns a shallow copy of the selection otherwise", () => {
    const selected = [1, 3];
    const result = selectionForSubmission(selected, LEVEL_OPTIONS);
    expect(result).toEqual([1, 3]);
    expect(result).not.toBe(selected);
  });
});

describe("open-list semantics — seed subset fields (e.g. Threat Name)", () => {
  const seedKinds = [
    { value: "port scan", label: "port scan" },
    { value: "http threat", label: "http threat" },
  ];

  it("selectionForSubmission submits the explicit selection when saturated", () => {
    // Without openList the "all selected" shortcut would drop the
    // field and silently broaden to every kind REview knows; with
    // openList the caller keeps the explicit visible selection.
    expect(
      selectionForSubmission(["port scan", "http threat"], seedKinds, {
        openList: true,
      }),
    ).toEqual(["port scan", "http threat"]);
  });

  it("selectionForSubmission still treats empty as 'omit the field'", () => {
    expect(
      selectionForSubmission([], seedKinds, { openList: true }),
    ).toBeNull();
  });

  it("buildMultiSelectChips still emits chips for a saturated open list", () => {
    const chips = buildMultiSelectChips({
      fieldKey: "kinds",
      fieldLabel: "Threat Name",
      options: seedKinds,
      selected: ["port scan", "http threat"],
      aggregateValue: countLabel,
      openList: true,
    });
    // Two individual chips — saturation is NOT "no filter" here.
    expect(chips).toHaveLength(2);
    expect(chips.every((c) => !c.aggregate)).toBe(true);
  });

  it("buildMultiSelectChips aggregates open-list selections above the 3 threshold", () => {
    const bigSeed = Array.from({ length: 5 }, (_, i) => ({
      value: `kind-${i}`,
      label: `kind-${i}`,
    }));
    const chips = buildMultiSelectChips({
      fieldKey: "kinds",
      fieldLabel: "Threat Name",
      options: bigSeed,
      selected: ["kind-0", "kind-1", "kind-2", "kind-3"],
      aggregateValue: countLabel,
      openList: true,
    });
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({ aggregate: true, value: "4 selected" });
  });
});
