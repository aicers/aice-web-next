import { describe, expect, it, vi } from "vitest";

// Mock the React + UI deps so we can import the pure helper without
// pulling in JSX at test time.
vi.mock("react", () => ({
  useEffect: vi.fn(),
  useState: (v: unknown) => [v, vi.fn()],
}));
vi.mock("lucide-react", () => ({
  Download: () => null,
  RefreshCw: () => null,
}));
vi.mock("@/components/ui/button", () => ({ Button: "button" }));
vi.mock("@/components/detection/event-row", () => ({
  EventRow: () => null,
}));

const labels = {
  headerCount: "Detected Events",
  headerCountKnown: "Detected Events {range} / {total}",
  headerCountRange: "{start}-{end}",
};

describe("formatHeaderCount", () => {
  it("falls back to the bare label before any query has run", async () => {
    const mod = await import("@/components/detection/event-list");
    expect(mod.formatHeaderCount(null, 0, labels)).toBe("Detected Events");
  });

  it("renders 0-0 / 0 for a zero-result query", async () => {
    const mod = await import("@/components/detection/event-list");
    expect(mod.formatHeaderCount("0", 0, labels)).toBe(
      "Detected Events 0-0 / 0",
    );
  });

  it("renders 1-N / total for a non-empty result set", async () => {
    const mod = await import("@/components/detection/event-list");
    expect(mod.formatHeaderCount("1234", 25, labels)).toBe(
      "Detected Events 1-25 / 1234",
    );
  });

  it("keeps the BigInt-safe total string intact (no numeric coercion)", async () => {
    const mod = await import("@/components/detection/event-list");
    const huge = "9007199254740993"; // Number.MAX_SAFE_INTEGER + 2
    expect(mod.formatHeaderCount(huge, 10, labels)).toBe(
      `Detected Events 1-10 / ${huge}`,
    );
  });
});
