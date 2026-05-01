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
    customerIds: [],
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

  it("preserves predefined endpoint references that the draft cannot represent", () => {
    // Reviewer Round 2: predefined endpoint groups have no shape in
    // `EndpointEntry`, so a saved filter (or any current filter)
    // carrying `{ direction, predefined }` would be silently dropped
    // when the drawer Apply rebuilt `endpoints` from the draft. The
    // pivot path preserves them; this path now does the same.
    const current: Filter = {
      mode: "structured",
      input: {
        start: "2026-04-22T10:00:00.000Z",
        end: "2026-04-22T11:00:00.000Z",
        endpoints: [
          { direction: "FROM", predefined: "net-1" },
          {
            direction: "TO",
            custom: { hosts: ["10.0.0.5"], networks: [], ranges: [] },
          },
        ],
      },
    };
    const next = buildAppliedFilter(current, draft());
    if (next.mode !== "structured") throw new Error("unreachable");
    expect(next.input.endpoints).toEqual([
      { direction: "FROM", predefined: "net-1" },
    ]);
  });

  // ── Customers (#384) ───────────────────────────────────────────
  it("converts the draft's numeric customerIds to wire-format strings", () => {
    const current: Filter = { mode: "structured", input: {} };
    const next = buildAppliedFilter(
      current,
      draft({ customerIds: [42, 7] }),
      false,
      true,
    );
    if (next.mode !== "structured") throw new Error("unreachable");
    // `IDScalar[]` on the wire — never raw numbers.
    expect(next.input.customers).toEqual(["42", "7"]);
    expect(next.input.customers?.every((v) => typeof v === "string")).toBe(
      true,
    );
  });

  it("omits the customers field when the draft is empty (no narrowing)", () => {
    const current: Filter = { mode: "structured", input: {} };
    const next = buildAppliedFilter(
      current,
      draft({ customerIds: [] }),
      false,
      true,
    );
    if (next.mode !== "structured") throw new Error("unreachable");
    expect(Object.hasOwn(next.input, "customers")).toBe(false);
  });

  it("clears a previous customers selection when the draft empties it", () => {
    const current: Filter = {
      mode: "structured",
      input: {
        start: "2026-04-22T10:00:00.000Z",
        end: "2026-04-22T11:00:00.000Z",
        customers: ["1", "2"],
      },
    };
    const next = buildAppliedFilter(
      current,
      draft({ customerIds: [] }),
      false,
      true,
    );
    if (next.mode !== "structured") throw new Error("unreachable");
    expect(Object.hasOwn(next.input, "customers")).toBe(false);
  });

  // Reviewer Round 8: Apply / Save during loading / error / empty-
  // scope must not submit `customers`. The drawer disables the
  // control in those states, but the draft can still hold IDs from
  // a bookmark / saved filter / pivot URL hydration. The gate at
  // `buildAppliedFilter` is the single point that enforces the
  // "filter submits no customers value until the customer list is
  // successfully loaded" contract.
  it("strips customerIds when the customer cache is not live (loading)", () => {
    const current: Filter = { mode: "structured", input: {} };
    const next = buildAppliedFilter(
      current,
      draft({ customerIds: [42, 7] }),
      false,
      false,
    );
    if (next.mode !== "structured") throw new Error("unreachable");
    expect(Object.hasOwn(next.input, "customers")).toBe(false);
  });

  it("strips a prior `customers` value when the customer cache is not live", () => {
    // A bookmark / saved filter hydrated `customers` onto the
    // committed input; the drawer's customer control is then in
    // `loading` / `error` / `No customer access`. Apply must not
    // re-emit those IDs even though they survived in the draft —
    // the destructure plus the disabled gate must drop them.
    const current: Filter = {
      mode: "structured",
      input: {
        start: "2026-04-22T10:00:00.000Z",
        end: "2026-04-22T11:00:00.000Z",
        customers: ["1", "2"],
      },
    };
    const next = buildAppliedFilter(
      current,
      draft({ customerIds: [1, 2] }),
      false,
      false,
    );
    if (next.mode !== "structured") throw new Error("unreachable");
    expect(Object.hasOwn(next.input, "customers")).toBe(false);
  });

  it("emits customerIds when the customer cache is live and the draft has IDs", () => {
    const current: Filter = { mode: "structured", input: {} };
    const next = buildAppliedFilter(
      current,
      draft({ customerIds: [3] }),
      false,
      true,
    );
    if (next.mode !== "structured") throw new Error("unreachable");
    expect(next.input.customers).toEqual(["3"]);
  });

  it("re-emits predefined endpoints alongside rebuilt custom rules", () => {
    const current: Filter = {
      mode: "structured",
      input: {
        start: "2026-04-22T10:00:00.000Z",
        end: "2026-04-22T11:00:00.000Z",
        endpoints: [{ direction: null, predefined: "net-2" }],
      },
    };
    const next = buildAppliedFilter(
      current,
      draft({
        endpoints: [
          {
            id: "1",
            raw: "10.0.0.1",
            kind: "host",
            host: "10.0.0.1",
            direction: "SOURCE",
            selected: true,
          },
        ],
      }),
    );
    if (next.mode !== "structured") throw new Error("unreachable");
    expect(next.input.endpoints).toEqual([
      { direction: null, predefined: "net-2" },
      {
        direction: "FROM",
        custom: { hosts: ["10.0.0.1"], networks: [], ranges: [] },
      },
    ]);
  });
});
