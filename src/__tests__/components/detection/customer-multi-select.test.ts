import { describe, expect, it, vi } from "vitest";

// Mock React + UI dependencies so the pure helpers exported from
// the client component can be imported without pulling JSX runtime
// or Radix internals into the test. Same approach as the
// `sensor-multi-select.test.ts` companion (#278).
vi.mock("react", () => ({
  useId: () => "t",
  useMemo: (fn: () => unknown) => fn(),
  useRef: (v: unknown) => ({ current: v }),
  useState: (v: unknown) => [v, vi.fn()],
}));
vi.mock("lucide-react", () => ({
  ChevronDown: "span",
  RefreshCw: "span",
  X: "span",
}));
vi.mock("@/components/ui/badge", () => ({ Badge: "span" }));
vi.mock("@/components/ui/button", () => ({ Button: "button" }));
vi.mock("@/components/ui/checkbox", () => ({ Checkbox: "input" }));
vi.mock("@/components/ui/input", () => ({ Input: "input" }));
vi.mock("@/lib/utils", () => ({ cn: (...xs: unknown[]) => xs.join(" ") }));

type Module = typeof import("@/components/detection/customer-multi-select");

const OPTIONS = [
  { id: 1, name: "Acme Inc." },
  { id: 2, name: "Beta Corp." },
  { id: 3, name: "Globex" },
  { id: 4, name: "Acmelabs" }, // name overlap for case-insensitive search
] as const;

describe("CustomerMultiSelect helpers", () => {
  let filterCustomersBySearch: Module["filterCustomersBySearch"];
  let areAllFilteredCustomersSelected: Module["areAllFilteredCustomersSelected"];
  let computeCustomerToggleNext: Module["computeCustomerToggleNext"];
  let computeCustomerToggleAllNext: Module["computeCustomerToggleAllNext"];
  let computeSelectedCustomerChips: Module["computeSelectedCustomerChips"];

  it("loads helpers", async () => {
    const mod = await import("@/components/detection/customer-multi-select");
    filterCustomersBySearch = mod.filterCustomersBySearch;
    areAllFilteredCustomersSelected = mod.areAllFilteredCustomersSelected;
    computeCustomerToggleNext = mod.computeCustomerToggleNext;
    computeCustomerToggleAllNext = mod.computeCustomerToggleAllNext;
    computeSelectedCustomerChips = mod.computeSelectedCustomerChips;
  });

  // ── Search filtering ─────────────────────────────────────────
  it("returns options unchanged for an empty / whitespace-only query", () => {
    expect(filterCustomersBySearch(OPTIONS, "")).toBe(OPTIONS);
    expect(filterCustomersBySearch(OPTIONS, "   ")).toBe(OPTIONS);
  });

  it("filters by case-insensitive substring match on name", () => {
    const result = filterCustomersBySearch(OPTIONS, "acme");
    expect(result.map((o) => o.id)).toEqual([1, 4]);
  });

  it("returns empty when no option matches", () => {
    expect(filterCustomersBySearch(OPTIONS, "zzz")).toEqual([]);
  });

  // ── Toggle wiring ────────────────────────────────────────────
  it("adds the id when toggling an unselected row", () => {
    expect(computeCustomerToggleNext([1], 2)).toEqual([1, 2]);
  });

  it("removes the id when toggling an already-selected row", () => {
    expect(computeCustomerToggleNext([1, 2], 1)).toEqual([2]);
  });

  // ── All / Clear toggle ──────────────────────────────────────
  it("reports allFilteredCustomersSelected based on filtered subset only", () => {
    const filtered = filterCustomersBySearch(OPTIONS, "acme");
    expect(areAllFilteredCustomersSelected(filtered, [1])).toBe(false);
    expect(areAllFilteredCustomersSelected(filtered, [1, 4])).toBe(true);
    expect(areAllFilteredCustomersSelected(filtered, [2])).toBe(false);
  });

  it("unions the filtered subset into the selection when not all selected", () => {
    const filtered = filterCustomersBySearch(OPTIONS, "acme");
    const next = computeCustomerToggleAllNext([2], filtered, false);
    expect(next.sort()).toEqual([1, 2, 4].sort());
  });

  it("clears only the filtered subset when all of it is already selected", () => {
    const filtered = filterCustomersBySearch(OPTIONS, "acme");
    const next = computeCustomerToggleAllNext([1, 2, 4], filtered, true);
    expect(next).toEqual([2]);
  });

  // ── Selected chips ───────────────────────────────────────────
  it("derives chips in selection order, dropping unknown ids", () => {
    const chips = computeSelectedCustomerChips(OPTIONS, [3, 9999, 1]);
    expect(chips.map((c) => c.id)).toEqual([3, 1]);
    expect(chips.map((c) => c.name)).toEqual(["Globex", "Acme Inc."]);
  });

  it("returns an empty chip list when nothing is selected", () => {
    expect(computeSelectedCustomerChips(OPTIONS, [])).toEqual([]);
  });
});
