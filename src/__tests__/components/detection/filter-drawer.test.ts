import { describe, expect, it, vi } from "vitest";

// Mock React + UI dependencies so we can import the pure helpers
// without pulling in JSX/runtime.
vi.mock("react", () => ({
  useEffect: vi.fn(),
  useRef: (v: unknown) => ({ current: v }),
  useState: (v: unknown) => [v, vi.fn()],
}));
vi.mock("@/components/ui/button", () => ({ Button: "button" }));
vi.mock("@/components/ui/input", () => ({ Input: "input" }));
vi.mock("@/components/ui/label", () => ({ Label: "label" }));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: "div",
  SheetContent: "div",
  SheetDescription: "div",
  SheetHeader: "div",
  SheetTitle: "div",
}));

type FilterDrawerModule = typeof import("@/components/detection/filter-drawer");

describe("filter-drawer helpers", () => {
  let isoToLocalInput: FilterDrawerModule["isoToLocalInput"];
  let localInputToIso: FilterDrawerModule["localInputToIso"];
  let applyManualStart: FilterDrawerModule["applyManualStart"];
  let applyManualEnd: FilterDrawerModule["applyManualEnd"];

  it("loads helpers", async () => {
    const mod = await import("@/components/detection/filter-drawer");
    isoToLocalInput = mod.isoToLocalInput;
    localInputToIso = mod.localInputToIso;
    applyManualStart = mod.applyManualStart;
    applyManualEnd = mod.applyManualEnd;
  });

  it("isoToLocalInput returns empty for null/undefined/invalid input", () => {
    expect(isoToLocalInput(null)).toBe("");
    expect(isoToLocalInput(undefined)).toBe("");
    expect(isoToLocalInput("")).toBe("");
    expect(isoToLocalInput("not-a-date")).toBe("");
  });

  it("localInputToIso returns null for empty/invalid input", () => {
    expect(localInputToIso("")).toBeNull();
    expect(localInputToIso("garbage")).toBeNull();
  });

  it("round-trips ISO → local → ISO minute-precision", () => {
    // Use a UTC minute boundary — datetime-local strips seconds.
    const iso = "2026-04-22T12:34:00.000Z";
    const local = isoToLocalInput(iso);
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    const back = localInputToIso(local);
    // Can't assert exact string without controlling TZ, but the
    // round-tripped instant should equal the original minute.
    expect(new Date(back ?? "").getTime()).toBe(new Date(iso).getTime());
  });

  it("isoToLocalInput produces an `<input type=datetime-local>`-shaped string", () => {
    const s = isoToLocalInput("2026-04-22T12:00:00.000Z");
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  // Regression: after a chip selection, the draft carries full-
  // precision ISO instants. A one-sided manual edit must normalize
  // BOTH ISO fields from the visible `datetime-local` strings so
  // the submitted range matches what the drawer shows.
  it("applyManualStart normalizes both ISO fields from local strings", () => {
    const chipStartIso = "2026-04-22T11:34:56.789Z";
    const chipEndIso = "2026-04-22T12:34:56.789Z";
    const draft = {
      period: "1h" as const,
      startLocal: isoToLocalInput(chipStartIso),
      endLocal: isoToLocalInput(chipEndIso),
      startIso: chipStartIso,
      endIso: chipEndIso,
      endpoints: [],
    };

    const newStartLocal = isoToLocalInput("2026-04-22T11:00:00.000Z");
    const next = applyManualStart(draft, newStartLocal);

    expect(next.period).toBeNull();
    expect(next.startLocal).toBe(newStartLocal);
    // endLocal is preserved as-is; both ISO fields agree with the
    // visible locals now — no hidden sub-minute drift survives.
    expect(next.endLocal).toBe(draft.endLocal);
    expect(next.startIso).toBe(localInputToIso(next.startLocal));
    expect(next.endIso).toBe(localInputToIso(next.endLocal));
  });

  it("applyManualEnd normalizes both ISO fields from local strings", () => {
    const chipStartIso = "2026-04-22T11:34:56.789Z";
    const chipEndIso = "2026-04-22T12:34:56.789Z";
    const draft = {
      period: "1h" as const,
      startLocal: isoToLocalInput(chipStartIso),
      endLocal: isoToLocalInput(chipEndIso),
      startIso: chipStartIso,
      endIso: chipEndIso,
      endpoints: [],
    };

    const newEndLocal = isoToLocalInput("2026-04-22T13:00:00.000Z");
    const next = applyManualEnd(draft, newEndLocal);

    expect(next.period).toBeNull();
    expect(next.endLocal).toBe(newEndLocal);
    expect(next.startLocal).toBe(draft.startLocal);
    expect(next.startIso).toBe(localInputToIso(next.startLocal));
    expect(next.endIso).toBe(localInputToIso(next.endLocal));
  });
});
