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
vi.mock("next-intl", () => ({
  useLocale: () => "en",
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

describe("relativePhrase", () => {
  const justNowEn = "just now";
  const justNowKo = "방금 전";

  it("returns the translated just-now label for diffs under a minute", async () => {
    const mod = await import("@/components/detection/event-list");
    expect(mod.relativePhrase(0, "en", justNowEn)).toBe(justNowEn);
    expect(mod.relativePhrase(45_000, "ko", justNowKo)).toBe(justNowKo);
  });

  it("emits a locale-aware minutes phrase for < 1h diffs", async () => {
    const mod = await import("@/components/detection/event-list");
    const en = mod.relativePhrase(5 * 60_000, "en", justNowEn);
    const ko = mod.relativePhrase(5 * 60_000, "ko", justNowKo);
    // `Intl.RelativeTimeFormat` output is locale-dependent; assert
    // that the locale branches diverge and that each branch carries
    // its own numeral + (for `en`) unit rather than a bare English
    // suffix like `5m`.
    expect(en).not.toBe("5m");
    expect(en).toContain("5");
    expect(en.toLowerCase()).toMatch(/minute/);
    expect(ko).not.toBe("5m");
    expect(ko).toContain("5");
    expect(ko).not.toEqual(en);
  });

  it("emits a locale-aware hours phrase for < 1d diffs", async () => {
    const mod = await import("@/components/detection/event-list");
    const en = mod.relativePhrase(3 * 60 * 60_000, "en", justNowEn);
    const ko = mod.relativePhrase(3 * 60 * 60_000, "ko", justNowKo);
    expect(en).not.toBe("3h");
    expect(en).toContain("3");
    expect(en.toLowerCase()).toMatch(/hour/);
    expect(ko).toContain("3");
    expect(ko).not.toEqual(en);
  });

  it("emits a locale-aware days phrase for ≥ 1d diffs", async () => {
    const mod = await import("@/components/detection/event-list");
    const en = mod.relativePhrase(2 * 24 * 60 * 60_000, "en", justNowEn);
    const ko = mod.relativePhrase(2 * 24 * 60 * 60_000, "ko", justNowKo);
    expect(en).not.toBe("2d");
    expect(en).toContain("2");
    expect(en.toLowerCase()).toMatch(/day/);
    expect(ko).toContain("2");
    expect(ko).not.toEqual(en);
  });
});
