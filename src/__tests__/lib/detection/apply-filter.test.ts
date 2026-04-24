import { describe, expect, it } from "vitest";

import { buildAppliedFilter } from "@/lib/detection/apply-filter";
import type { Filter } from "@/lib/detection/filter";
import type { DetectionFilterDraft } from "@/lib/detection/filter-draft";

const START = "2026-04-22T11:00:00.000Z";
const END = "2026-04-22T12:00:00.000Z";

function draft(
  overrides: Partial<DetectionFilterDraft> = {},
): DetectionFilterDraft {
  return {
    period: null,
    startLocal: "2026-04-22T11:00",
    endLocal: "2026-04-22T12:00",
    startIso: START,
    endIso: END,
    directions: ["OUTBOUND", "INTERNAL", "INBOUND"],
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

describe("buildAppliedFilter", () => {
  it("omits both confidence keys when the draft is at the [0, 1] default", () => {
    const current: Filter = { mode: "structured", input: {} };
    const next = buildAppliedFilter(current, draft());

    expect(next.mode).toBe("structured");
    if (next.mode !== "structured") throw new Error("unreachable");

    // Assert *key absence*, not just a null value. The GraphQL
    // client forwards the variables object as-is, so sending
    // explicit nulls would violate the "omit when at default"
    // contract.
    expect(Object.hasOwn(next.input, "confidenceMin")).toBe(false);
    expect(Object.hasOwn(next.input, "confidenceMax")).toBe(false);
    expect(next.input.start).toBe(START);
    expect(next.input.end).toBe(END);
  });

  it("includes both confidence keys when the draft is non-default", () => {
    const current: Filter = { mode: "structured", input: {} };
    const next = buildAppliedFilter(
      current,
      draft({ confidenceMin: 0.7, confidenceMax: 1 }),
    );
    if (next.mode !== "structured") throw new Error("unreachable");
    expect(next.input.confidenceMin).toBe(0.7);
    expect(next.input.confidenceMax).toBe(1);
  });

  it("drops a stale confidence range when the new draft is at the default", () => {
    // Previously committed filter still carries a non-default
    // confidence range; user resets the drawer to [0, 1] and applies.
    const current: Filter = {
      mode: "structured",
      input: { start: START, end: END, confidenceMin: 0.5, confidenceMax: 0.9 },
    };
    const next = buildAppliedFilter(current, draft());
    if (next.mode !== "structured") throw new Error("unreachable");

    expect(Object.hasOwn(next.input, "confidenceMin")).toBe(false);
    expect(Object.hasOwn(next.input, "confidenceMax")).toBe(false);
  });

  it("preserves non-confidence fields from the current structured filter", () => {
    const current: Filter = {
      mode: "structured",
      input: {
        start: "2026-04-22T10:00:00.000Z",
        end: "2026-04-22T11:00:00.000Z",
        categories: [1],
      },
    };
    const next = buildAppliedFilter(current, draft());
    if (next.mode !== "structured") throw new Error("unreachable");
    expect(next.input.categories).toEqual([1]);
    // The new start/end override the prior ones.
    expect(next.input.start).toBe(START);
    expect(next.input.end).toBe(END);
  });

  it("treats a non-structured current filter as a blank base", () => {
    const current: Filter = { mode: "query", text: "foo" };
    const next = buildAppliedFilter(current, draft());
    expect(next.mode).toBe("structured");
    if (next.mode !== "structured") throw new Error("unreachable");
    expect(next.input.start).toBe(START);
    expect(next.input.end).toBe(END);
  });

  it("omits start/end when the draft has neither set (no-time Apply)", () => {
    // Pending `+` tab path: the operator cleared the default
    // `Last 1 hour` chip on a new tab and hit Apply. `buildAppliedFilter`
    // must produce a filter with no time bounds — not throw, not carry
    // a stale prior `start`/`end` — so the first query on that tab
    // runs as an all-time query the same way chip-removal on a
    // committed tab does.
    const current: Filter = { mode: "structured", input: {} };
    const next = buildAppliedFilter(
      current,
      draft({ startIso: null, endIso: null, startLocal: "", endLocal: "" }),
    );
    if (next.mode !== "structured") throw new Error("unreachable");
    expect(Object.hasOwn(next.input, "start")).toBe(false);
    expect(Object.hasOwn(next.input, "end")).toBe(false);
  });

  it("drops a prior start/end when the draft has neither set", () => {
    // Safety: even if the committed filter still carries a time range
    // (e.g. the draft got cleared programmatically mid-flow), the
    // no-time Apply must produce a filter whose time bounds are
    // genuinely absent — not inherited from the prior commit.
    const current: Filter = {
      mode: "structured",
      input: { start: START, end: END, levels: [1] },
    };
    const next = buildAppliedFilter(
      current,
      draft({ startIso: null, endIso: null, startLocal: "", endLocal: "" }),
    );
    if (next.mode !== "structured") throw new Error("unreachable");
    expect(Object.hasOwn(next.input, "start")).toBe(false);
    expect(Object.hasOwn(next.input, "end")).toBe(false);
    expect(next.input.levels).toEqual([1]);
  });

  it("throws on a one-sided draft range", () => {
    // The drawer's submit validator already rejects one-sided ranges.
    // This guards the lib-layer entry point against programmatic
    // callers that skip the drawer.
    const current: Filter = { mode: "structured", input: {} };
    expect(() =>
      buildAppliedFilter(current, draft({ endIso: null, endLocal: "" })),
    ).toThrow();
    expect(() =>
      buildAppliedFilter(current, draft({ startIso: null, startLocal: "" })),
    ).toThrow();
  });
});
