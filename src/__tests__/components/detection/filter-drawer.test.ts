import { describe, expect, it } from "vitest";

import {
  applyConfidenceMax,
  applyConfidenceMin,
  applyManualEnd,
  applyManualStart,
  type DetectionFilterDraft,
  formatConfidenceInput,
  isConfidenceDefault,
  isDraftRangeValid,
  isoToLocalInput,
  localInputToIso,
  normalizeDraftForSubmit,
  parseConfidenceValue,
  setConfidenceMax,
  setConfidenceMin,
} from "@/lib/detection/filter-draft";
import type { FlowKind } from "@/lib/detection/types";

describe("filter-draft helpers", () => {
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
    const draft: DetectionFilterDraft = baseDraft({
      period: "1h",
      startLocal: isoToLocalInput(chipStartIso),
      endLocal: isoToLocalInput(chipEndIso),
      startIso: chipStartIso,
      endIso: chipEndIso,
    });

    const newStartLocal = isoToLocalInput("2026-04-22T11:00:00.000Z");
    const next = applyManualStart(draft, newStartLocal);

    expect(next.period).toBeNull();
    expect(next.startLocal).toBe(newStartLocal);
    // endLocal is preserved as-is; both ISO fields agree with the
    // visible locals now — no hidden sub-minute drift survives.
    expect(next.endLocal).toBe(draft.endLocal);
    expect(next.startIso).toBe(localInputToIso(next.startLocal));
    expect(next.endIso).toBe(localInputToIso(next.endLocal));
    expect(next.directions).toEqual(draft.directions);
  });

  it("applyManualEnd normalizes both ISO fields from local strings", () => {
    const chipStartIso = "2026-04-22T11:34:56.789Z";
    const chipEndIso = "2026-04-22T12:34:56.789Z";
    const draft: DetectionFilterDraft = baseDraft({
      period: "1h",
      startLocal: isoToLocalInput(chipStartIso),
      endLocal: isoToLocalInput(chipEndIso),
      startIso: chipStartIso,
      endIso: chipEndIso,
    });

    const newEndLocal = isoToLocalInput("2026-04-22T13:00:00.000Z");
    const next = applyManualEnd(draft, newEndLocal);

    expect(next.period).toBeNull();
    expect(next.endLocal).toBe(newEndLocal);
    expect(next.startLocal).toBe(draft.startLocal);
    expect(next.startIso).toBe(localInputToIso(next.startLocal));
    expect(next.endIso).toBe(localInputToIso(next.endLocal));
  });

  function baseDraft(
    overrides: Partial<DetectionFilterDraft> = {},
  ): DetectionFilterDraft {
    return {
      period: null,
      startLocal: "",
      endLocal: "",
      startIso: null,
      endIso: null,
      directions: ["OUTBOUND", "INTERNAL", "INBOUND"] as FlowKind[],
      endpoints: [],
      confidenceMin: 0,
      confidenceMax: 1,
      sensorIds: [],
      levels: [],
      countries: [],
      learningMethods: [],
      categories: [],
      kinds: [],
      source: "",
      destination: "",
      keywords: [],
      hostnames: [],
      userIds: [],
      userNames: [],
      userDepartments: [],
      ...overrides,
    };
  }

  it("isConfidenceDefault is true only for the [0, 1] domain ends", () => {
    expect(isConfidenceDefault({ confidenceMin: 0, confidenceMax: 1 })).toBe(
      true,
    );
    expect(isConfidenceDefault({ confidenceMin: 0.01, confidenceMax: 1 })).toBe(
      false,
    );
    expect(isConfidenceDefault({ confidenceMin: 0, confidenceMax: 0.99 })).toBe(
      false,
    );
  });

  it("parseConfidenceValue clamps into [0, 1] and rounds to 0.01", () => {
    expect(parseConfidenceValue("0.5", 0)).toBe(0.5);
    expect(parseConfidenceValue("1.5", 0)).toBe(1);
    expect(parseConfidenceValue("-0.2", 0.3)).toBe(0);
    expect(parseConfidenceValue("0.777", 0)).toBe(0.78);
    // Empty / garbage input falls back to the supplied default.
    expect(parseConfidenceValue("", 0.4)).toBe(0.4);
    expect(parseConfidenceValue("abc", 0.4)).toBe(0.4);
  });

  it("formatConfidenceInput renders two-decimal strings", () => {
    expect(formatConfidenceInput(0)).toBe("0.00");
    expect(formatConfidenceInput(0.7)).toBe("0.70");
    expect(formatConfidenceInput(1)).toBe("1.00");
  });

  it("applyConfidenceMin updates the draft within the domain", () => {
    const next = applyConfidenceMin(baseDraft(), "0.30");
    expect(next.confidenceMin).toBe(0.3);
    expect(next.confidenceMax).toBe(1);
  });

  it("applyConfidenceMin snaps max upward to preserve min <= max", () => {
    const draft = baseDraft({ confidenceMin: 0.2, confidenceMax: 0.5 });
    const next = applyConfidenceMin(draft, "0.80");
    expect(next.confidenceMin).toBe(0.8);
    // New min exceeded the previous max — max snaps up so min <= max holds.
    expect(next.confidenceMax).toBe(0.8);
  });

  it("applyConfidenceMax snaps min downward to preserve min <= max", () => {
    const draft = baseDraft({ confidenceMin: 0.6, confidenceMax: 1 });
    const next = applyConfidenceMax(draft, "0.40");
    expect(next.confidenceMax).toBe(0.4);
    expect(next.confidenceMin).toBe(0.4);
  });

  it("setConfidenceMin / setConfidenceMax clamp into the domain", () => {
    const draft = baseDraft();
    expect(setConfidenceMin(draft, -1).confidenceMin).toBe(0);
    expect(setConfidenceMax(draft, 5).confidenceMax).toBe(1);
  });

  // Regression: when the user types whitespace-padded `source` /
  // `destination` or leaves a duplicate/trailing-whitespace tag in
  // any list, Apply commits the trimmed/deduped canonical form. The
  // shell mirrors this normalized draft back into its cached draft
  // so reopening the drawer shows the committed values rather than
  // the original padded input.
  it("normalizeDraftForSubmit trims text fields and dedupes tag fields", () => {
    const startIso = "2026-04-22T11:00:00.000Z";
    const endIso = "2026-04-22T12:00:00.000Z";
    const draft = baseDraft({
      startLocal: isoToLocalInput(startIso),
      endLocal: isoToLocalInput(endIso),
      startIso,
      endIso,
      source: "  10.0.0.5  ",
      destination: "   ",
      keywords: [" alpha ", "beta", "beta", "", "  "],
      hostnames: ["host-a", " host-a ", "host-b"],
      userIds: ["  "],
      userNames: [],
      userDepartments: ["ops"],
    });

    const out = normalizeDraftForSubmit(draft);

    // Single-value text fields are trimmed; a whitespace-only value
    // collapses to "" so the shell's nonEmptyString gate drops it.
    expect(out.source).toBe("10.0.0.5");
    expect(out.destination).toBe("");
    // Tag fields: trim, drop empties, dedupe preserving first-seen
    // order.
    expect(out.keywords).toEqual(["alpha", "beta"]);
    expect(out.hostnames).toEqual(["host-a", "host-b"]);
    expect(out.userIds).toEqual([]);
    expect(out.userNames).toEqual([]);
    expect(out.userDepartments).toEqual(["ops"]);
    // Period / range fields are passed through untouched.
    expect(out.period).toBeNull();
    expect(out.startIso).toBe(startIso);
    expect(out.endIso).toBe(endIso);
  });

  // The drawer's Apply and Save buttons share `commitRangeGate`, which
  // delegates to `isDraftRangeValid`. A regression on this helper is
  // why a reversed-range draft used to slip through Save and persist a
  // saved filter that Apply would have rejected (Round 5 P2).
  it("isDraftRangeValid rejects missing or reversed start/end", () => {
    expect(isDraftRangeValid({ startIso: null, endIso: null })).toBe(false);
    expect(
      isDraftRangeValid({ startIso: null, endIso: "2026-04-22T12:00:00.000Z" }),
    ).toBe(false);
    expect(
      isDraftRangeValid({
        startIso: "2026-04-22T11:00:00.000Z",
        endIso: null,
      }),
    ).toBe(false);
    // Reversed range — Apply rejects this with the inline range error.
    expect(
      isDraftRangeValid({
        startIso: "2026-04-22T13:00:00.000Z",
        endIso: "2026-04-22T12:00:00.000Z",
      }),
    ).toBe(false);
    // Equal endpoints are also rejected — REview requires start < end.
    expect(
      isDraftRangeValid({
        startIso: "2026-04-22T12:00:00.000Z",
        endIso: "2026-04-22T12:00:00.000Z",
      }),
    ).toBe(false);
    expect(
      isDraftRangeValid({
        startIso: "2026-04-22T11:00:00.000Z",
        endIso: "2026-04-22T12:00:00.000Z",
      }),
    ).toBe(true);
  });

  // Regression: normalize is idempotent, which is what lets the shell
  // safely store the result back as its cached draft without a new
  // Apply producing a different canonical form.
  it("normalizeDraftForSubmit is idempotent", () => {
    const startIso = "2026-04-22T11:00:00.000Z";
    const endIso = "2026-04-22T12:00:00.000Z";
    const draft = baseDraft({
      startLocal: isoToLocalInput(startIso),
      endLocal: isoToLocalInput(endIso),
      startIso,
      endIso,
      source: "  10.0.0.5  ",
      destination: "host.example",
      keywords: [" dup ", "dup", "other"],
    });

    const once = normalizeDraftForSubmit(draft);
    const twice = normalizeDraftForSubmit(once);
    expect(twice).toEqual(once);
  });
});
