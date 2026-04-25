import { describe, expect, it } from "vitest";

import type { Filter } from "@/lib/detection/filter";
import {
  filterIdentitiesEqual,
  filtersAreEquivalent,
  normalizeFilterIdentity,
} from "@/lib/detection/filter-identity";
import type { EventListFilterInput } from "@/lib/detection/types";

const ISO_A_START = "2026-04-25T00:00:00.000Z";
const ISO_A_END = "2026-04-25T01:00:00.000Z";

function structured(input: EventListFilterInput): Filter {
  return { mode: "structured", input };
}

describe("normalizeFilterIdentity", () => {
  it("returns the same identity for arrays in different orders", () => {
    const a = normalizeFilterIdentity({
      filter: structured({ kinds: ["HttpThreat", "DnsCovertChannel"] }),
      period: null,
    });
    const b = normalizeFilterIdentity({
      filter: structured({ kinds: ["DnsCovertChannel", "HttpThreat"] }),
      period: null,
    });
    expect(a).toBe(b);
  });

  it("dedupes repeated array values", () => {
    const a = normalizeFilterIdentity({
      filter: structured({ countries: ["KR", "KR", "US"] }),
      period: null,
    });
    const b = normalizeFilterIdentity({
      filter: structured({ countries: ["US", "KR"] }),
      period: null,
    });
    expect(a).toBe(b);
  });

  it("treats undefined and empty arrays as identical", () => {
    const a = normalizeFilterIdentity({
      filter: structured({ kinds: [] }),
      period: null,
    });
    const b = normalizeFilterIdentity({
      filter: structured({}),
      period: null,
    });
    expect(a).toBe(b);
  });

  it("uses the period key in place of the literal start/end when provided", () => {
    const a = normalizeFilterIdentity({
      filter: structured({
        start: ISO_A_START,
        end: ISO_A_END,
        kinds: ["HttpThreat"],
      }),
      period: "1h",
    });
    const b = normalizeFilterIdentity({
      filter: structured({
        // Different ISO range — both tabs were created at different
        // moments — but the relative period should match.
        start: "2026-04-25T05:00:00.000Z",
        end: "2026-04-25T06:00:00.000Z",
        kinds: ["HttpThreat"],
      }),
      period: "1h",
    });
    expect(a).toBe(b);
  });

  it("falls back to literal start/end when period is null", () => {
    const a = normalizeFilterIdentity({
      filter: structured({ start: ISO_A_START, end: ISO_A_END }),
      period: null,
    });
    const b = normalizeFilterIdentity({
      filter: structured({ start: ISO_A_START, end: ISO_A_END }),
      period: null,
    });
    expect(a).toBe(b);
    const c = normalizeFilterIdentity({
      filter: structured({ start: "different", end: ISO_A_END }),
      period: null,
    });
    expect(a).not.toBe(c);
  });

  it("normalizes endpoints by direction and host order", () => {
    const a = normalizeFilterIdentity({
      filter: structured({
        endpoints: [
          {
            direction: "FROM",
            custom: {
              hosts: ["10.0.0.5", "10.0.0.1"],
              networks: [],
              ranges: [],
            },
          },
        ],
      }),
      period: null,
    });
    const b = normalizeFilterIdentity({
      filter: structured({
        endpoints: [
          {
            direction: "FROM",
            custom: {
              hosts: ["10.0.0.1", "10.0.0.5"],
              networks: [],
              ranges: [],
            },
          },
        ],
      }),
      period: null,
    });
    expect(a).toBe(b);
  });

  it("distinguishes endpoints under different directions", () => {
    const fromOnly = normalizeFilterIdentity({
      filter: structured({
        endpoints: [
          {
            direction: "FROM",
            custom: { hosts: ["10.0.0.5"], networks: [], ranges: [] },
          },
        ],
      }),
      period: null,
    });
    const toOnly = normalizeFilterIdentity({
      filter: structured({
        endpoints: [
          {
            direction: "TO",
            custom: { hosts: ["10.0.0.5"], networks: [], ranges: [] },
          },
        ],
      }),
      period: null,
    });
    expect(fromOnly).not.toBe(toOnly);
  });

  it("distinguishes tabs that differ only by `customers` (Reviewer Round 1)", () => {
    // Two tabs that only differ in the `customers` scope MUST compare
    // as distinct identities. The pivot toast / focus path used
    // `normalizeFilterIdentity` to recognise duplicates, so omitting
    // a schema-backed field would have collapsed a customer-scoped
    // tab into an unscoped one with the same visible pivot field —
    // surfacing as either a stale-tab focus or a suppressed creation.
    const scoped = normalizeFilterIdentity({
      filter: structured({ kinds: ["HttpThreat"], customers: ["cust-1"] }),
      period: null,
    });
    const unscoped = normalizeFilterIdentity({
      filter: structured({ kinds: ["HttpThreat"] }),
      period: null,
    });
    expect(scoped).not.toBe(unscoped);
  });

  it("distinguishes tabs that differ only by `networkTags` / `os` / `devices` / `triagePolicies` (Reviewer Round 1)", () => {
    const baseline = structured({ kinds: ["HttpThreat"] });
    const withNetworkTags = structured({
      kinds: ["HttpThreat"],
      networkTags: ["tag-1"],
    });
    const withOs = structured({ kinds: ["HttpThreat"], os: ["windows"] });
    const withDevices = structured({
      kinds: ["HttpThreat"],
      devices: ["dev-1"],
    });
    const withTriage = structured({
      kinds: ["HttpThreat"],
      triagePolicies: ["policy-1"],
    });
    const baselineId = normalizeFilterIdentity({
      filter: baseline,
      period: null,
    });
    expect(
      normalizeFilterIdentity({ filter: withNetworkTags, period: null }),
    ).not.toBe(baselineId);
    expect(normalizeFilterIdentity({ filter: withOs, period: null })).not.toBe(
      baselineId,
    );
    expect(
      normalizeFilterIdentity({ filter: withDevices, period: null }),
    ).not.toBe(baselineId);
    expect(
      normalizeFilterIdentity({ filter: withTriage, period: null }),
    ).not.toBe(baselineId);
  });

  it("normalizes the new array fields (customers / networkTags / os / devices / triagePolicies) — order, dedupe", () => {
    const a = normalizeFilterIdentity({
      filter: structured({
        customers: ["c-2", "c-1", "c-1"],
        networkTags: ["t-2", "t-1"],
        os: ["mac", "linux", "linux"],
        devices: ["d-2", "d-1"],
        triagePolicies: ["p-2", "p-1", "p-2"],
      }),
      period: null,
    });
    const b = normalizeFilterIdentity({
      filter: structured({
        customers: ["c-1", "c-2"],
        networkTags: ["t-1", "t-2"],
        os: ["linux", "mac"],
        devices: ["d-1", "d-2"],
        triagePolicies: ["p-1", "p-2"],
      }),
      period: null,
    });
    expect(a).toBe(b);
  });

  it("distinguishes endpoints that differ only by `predefined` id (Reviewer Round 1)", () => {
    const predefinedOne = normalizeFilterIdentity({
      filter: structured({
        endpoints: [{ direction: "FROM", predefined: "net-1" }],
      }),
      period: null,
    });
    const predefinedTwo = normalizeFilterIdentity({
      filter: structured({
        endpoints: [{ direction: "FROM", predefined: "net-2" }],
      }),
      period: null,
    });
    expect(predefinedOne).not.toBe(predefinedTwo);
  });

  it("preserves a predefined-only endpoint entry (no custom payload) instead of dropping it (Reviewer Round 1)", () => {
    const predefinedOnly = normalizeFilterIdentity({
      filter: structured({
        endpoints: [{ direction: "FROM", predefined: "net-1" }],
      }),
      period: null,
    });
    const empty = normalizeFilterIdentity({
      filter: structured({}),
      period: null,
    });
    // The pre-fix shape skipped any entry whose `custom` was missing,
    // collapsing predefined-only filters into the empty filter — that
    // would have made any pivot from a "Internal network" tab focus
    // (or duplicate-toast against) the unscoped tab.
    expect(predefinedOnly).not.toBe(empty);
  });

  it("treats query-mode filters by the trimmed text", () => {
    const a = normalizeFilterIdentity({
      filter: { mode: "query", text: "  level:high  " },
      period: null,
    });
    const b = normalizeFilterIdentity({
      filter: { mode: "query", text: "level:high" },
      period: null,
    });
    expect(a).toBe(b);
  });
});

describe("filtersAreEquivalent / filterIdentitiesEqual", () => {
  it("reports equality through the helper", () => {
    expect(
      filtersAreEquivalent(
        { filter: structured({ kinds: ["HttpThreat"] }), period: null },
        { filter: structured({ kinds: ["HttpThreat"] }), period: null },
      ),
    ).toBe(true);
  });

  it("reports inequality when one side carries an extra value", () => {
    expect(
      filtersAreEquivalent(
        { filter: structured({ kinds: ["HttpThreat"] }), period: null },
        {
          filter: structured({ kinds: ["HttpThreat", "DnsCovertChannel"] }),
          period: null,
        },
      ),
    ).toBe(false);
  });

  it("delegates to identity-string equality", () => {
    const a = normalizeFilterIdentity({
      filter: structured({}),
      period: "1h",
    });
    const b = normalizeFilterIdentity({
      filter: structured({}),
      period: "1h",
    });
    expect(filterIdentitiesEqual(a, b)).toBe(true);
  });
});
