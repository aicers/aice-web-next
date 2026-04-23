import { describe, expect, it, vi } from "vitest";

// Stub React + UI primitives so the component module loads without a
// JSX runtime. This suite deliberately only exercises the pure
// derivations the component exports — the rendered DOM / keyboard
// behaviour is out of scope because this project does not carry a
// jsdom/RTL stack (adding one is a separate cross-repo decision).
vi.mock("react", () => ({
  useId: () => "auto-id",
  useMemo: (fn: () => unknown) => fn(),
  useState: <T>(initial: T) => [initial, vi.fn()] as const,
}));
vi.mock("@/components/ui/checkbox", () => ({ Checkbox: "input" }));
vi.mock("@/components/ui/input", () => ({ Input: "input" }));
vi.mock("lucide-react", () => ({ ChevronDown: "svg" }));
vi.mock("@/lib/utils", () => ({ cn: (...xs: unknown[]) => xs.join(" ") }));

// The helpers under test are re-exports of the actual functions the
// component calls, not copies. A drift in search / all-state /
// summary logic now fails this file.
import {
  filterMultiSelectOptions,
  masterToggleState,
  multiSelectSummary,
} from "@/components/detection/filter-multi-select";

describe("filterMultiSelectOptions — case-insensitive substring search", () => {
  const options = [
    { value: "US", label: "United States", searchText: "US" },
    { value: "GB", label: "United Kingdom", searchText: "GB" },
    { value: "KR", label: "Korea", searchText: "KR" },
  ];

  it("matches the primary label case-insensitively", () => {
    expect(
      filterMultiSelectOptions(options, "united").map((o) => o.label),
    ).toEqual(["United States", "United Kingdom"]);
    expect(
      filterMultiSelectOptions(options, "UNITED").map((o) => o.label),
    ).toEqual(["United States", "United Kingdom"]);
  });

  it("matches the secondary searchText (e.g. ISO code)", () => {
    expect(filterMultiSelectOptions(options, "kr").map((o) => o.label)).toEqual(
      ["Korea"],
    );
    expect(filterMultiSelectOptions(options, "GB").map((o) => o.label)).toEqual(
      ["United Kingdom"],
    );
  });

  it("returns all options for an empty or whitespace-only query", () => {
    expect(filterMultiSelectOptions(options, "")).toEqual(options);
    expect(filterMultiSelectOptions(options, "   ")).toEqual(options);
  });

  it("returns no options when nothing matches", () => {
    expect(filterMultiSelectOptions(options, "xyz")).toEqual([]);
  });
});

describe("multiSelectSummary — trigger text derivation", () => {
  const labels = {
    summaryNone: "All",
    summaryAll: "All",
    summarySome: (n: number) => `${n} selected`,
  };

  it("renders summaryNone when nothing is selected", () => {
    expect(multiSelectSummary(0, 5, false, labels)).toBe("All");
    expect(multiSelectSummary(0, 5, true, labels)).toBe("All");
  });

  it("renders summaryAll when a closed list is saturated", () => {
    expect(multiSelectSummary(5, 5, false, labels)).toBe("All");
  });

  it("renders summarySome for a partial closed-list selection", () => {
    expect(multiSelectSummary(2, 5, false, labels)).toBe("2 selected");
  });

  it("renders summarySome for an open list, even when every visible option is checked", () => {
    // Regression for Round 2 review — an open-list field (e.g.
    // Threat Name while `kinds` has a seed subset) must not reuse
    // the closed-list "All = no filter" wording when saturated,
    // because the submitted filter still constrains to the visible
    // subset.
    expect(multiSelectSummary(5, 5, true, labels)).toBe("5 selected");
    expect(multiSelectSummary(3, 5, true, labels)).toBe("3 selected");
  });

  it("falls back to summaryNone when there are no options at all", () => {
    expect(multiSelectSummary(0, 0, false, labels)).toBe("All");
    expect(multiSelectSummary(0, 0, true, labels)).toBe("All");
  });
});

describe("masterToggleState — all/mixed/none derivation", () => {
  it("reports 'none' when nothing is selected", () => {
    expect(masterToggleState(0, 5)).toBe("none");
  });

  it("reports 'all' when every option is selected", () => {
    expect(masterToggleState(5, 5)).toBe("all");
  });

  it("reports 'mixed' for a partial selection", () => {
    expect(masterToggleState(2, 5)).toBe("mixed");
  });

  it("reports 'none' when the option list is empty", () => {
    expect(masterToggleState(0, 0)).toBe("none");
  });
});
