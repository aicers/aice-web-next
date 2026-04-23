import { describe, expect, it, vi } from "vitest";

// Mock React + UI dependencies so the pure helpers exported from
// the client component can be imported without pulling JSX runtime
// or Radix internals into the test.
vi.mock("react", () => ({
  useId: () => "t",
  useMemo: (fn: () => unknown) => fn(),
  useRef: (v: unknown) => ({ current: v }),
  useState: (v: unknown) => [v, vi.fn()],
}));
vi.mock("lucide-react", () => ({ ChevronDown: "span", X: "span" }));
vi.mock("@/components/ui/badge", () => ({ Badge: "span" }));
vi.mock("@/components/ui/checkbox", () => ({ Checkbox: "input" }));
vi.mock("@/components/ui/input", () => ({ Input: "input" }));
vi.mock("@/lib/utils", () => ({ cn: (...xs: unknown[]) => xs.join(" ") }));

type Module = typeof import("@/components/detection/sensor-multi-select");

const OPTIONS = [
  { id: "s1", name: "Alpha" },
  { id: "s2", name: "Beta" },
  { id: "s3", name: "Gamma" },
  { id: "s4", name: "alphabet" }, // name overlap for case-insensitive search
] as const;

describe("SensorMultiSelect helpers", () => {
  let filterSensorsBySearch: Module["filterSensorsBySearch"];
  let areAllFilteredSelected: Module["areAllFilteredSelected"];
  let computeToggleNext: Module["computeToggleNext"];
  let computeToggleAllNext: Module["computeToggleAllNext"];
  let computeSelectedChips: Module["computeSelectedChips"];

  it("loads helpers", async () => {
    const mod = await import("@/components/detection/sensor-multi-select");
    filterSensorsBySearch = mod.filterSensorsBySearch;
    areAllFilteredSelected = mod.areAllFilteredSelected;
    computeToggleNext = mod.computeToggleNext;
    computeToggleAllNext = mod.computeToggleAllNext;
    computeSelectedChips = mod.computeSelectedChips;
  });

  // Search filtering -----------------------------------------------

  it("returns options unchanged for an empty or whitespace-only query", () => {
    expect(filterSensorsBySearch(OPTIONS, "")).toBe(OPTIONS);
    expect(filterSensorsBySearch(OPTIONS, "   ")).toBe(OPTIONS);
  });

  it("filters by case-insensitive substring match on name", () => {
    const result = filterSensorsBySearch(OPTIONS, "alp");
    expect(result.map((o) => o.id)).toEqual(["s1", "s4"]);
  });

  it("returns empty when no option matches", () => {
    expect(filterSensorsBySearch(OPTIONS, "zzz")).toEqual([]);
  });

  // Toggle wiring (single row -> onChange payload) -----------------

  it("adds the id when toggling a row that is not selected", () => {
    expect(computeToggleNext(["s1"], "s2")).toEqual(["s1", "s2"]);
  });

  it("removes the id when toggling an already-selected row", () => {
    expect(computeToggleNext(["s1", "s2"], "s1")).toEqual(["s2"]);
  });

  it("preserves selection order when toggling", () => {
    expect(computeToggleNext(["s3", "s1"], "s2")).toEqual(["s3", "s1", "s2"]);
  });

  // All / Clear toggle --------------------------------------------

  it("reports allFilteredSelected=false for an empty filtered subset", () => {
    expect(areAllFilteredSelected([], ["s1"])).toBe(false);
  });

  it("reports allFilteredSelected based on filtered subset only", () => {
    const filtered = filterSensorsBySearch(OPTIONS, "alp");
    expect(areAllFilteredSelected(filtered, ["s1"])).toBe(false);
    expect(areAllFilteredSelected(filtered, ["s1", "s4"])).toBe(true);
    // A selection outside the filtered subset is ignored by the
    // "all selected?" check — that's what lets a search-scoped All
    // toggle operate only on what the user can currently see.
    expect(areAllFilteredSelected(filtered, ["s2"])).toBe(false);
  });

  it("unions the filtered subset into the selection when not all selected", () => {
    const filtered = filterSensorsBySearch(OPTIONS, "alp");
    const next = computeToggleAllNext(["s2"], filtered, false);
    expect(next.sort()).toEqual(["s1", "s2", "s4"].sort());
  });

  it("clears only the filtered subset when all of it is already selected", () => {
    // Regression anchor: a search-scoped deselect must not wipe
    // selections hidden by the current query.
    const filtered = filterSensorsBySearch(OPTIONS, "alp");
    const next = computeToggleAllNext(["s1", "s2", "s4"], filtered, true);
    expect(next).toEqual(["s2"]);
  });

  // Selected chips (what ends up rendered below the panel) --------

  it("derives chips in selection order, dropping unknown ids", () => {
    const chips = computeSelectedChips(OPTIONS, ["s3", "missing", "s1"]);
    expect(chips.map((c) => c.id)).toEqual(["s3", "s1"]);
    expect(chips.map((c) => c.name)).toEqual(["Gamma", "Alpha"]);
  });

  it("returns an empty chip list when nothing is selected", () => {
    expect(computeSelectedChips(OPTIONS, [])).toEqual([]);
  });
});
