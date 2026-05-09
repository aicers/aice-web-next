import { describe, expect, it } from "vitest";

import type { Filter } from "@/lib/detection/filter";
import {
  analyticsFilterIdentity,
  filterIdentitiesEqual,
  filtersAreEquivalent,
  filtersAreEquivalentIgnoringTime,
  normalizeFilterIdentity,
  normalizeFilterIdentityIgnoringTime,
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

describe("analyticsFilterIdentity", () => {
  it("treats two windows that share a relative period chip but different ISO bounds as distinct", () => {
    // Reviewer Round 2 (P2 freshness): re-applying `Last 1 hour`
    // recomputes new ISO bounds but leaves the period chip the
    // same. The pivot identity (period: "1h") would collapse both
    // windows together; analytics must treat them as distinct so
    // the open strip refetches against the new window.
    const a = analyticsFilterIdentity(
      structured({ start: ISO_A_START, end: ISO_A_END }),
    );
    const b = analyticsFilterIdentity(
      structured({
        start: "2026-04-25T05:00:00.000Z",
        end: "2026-04-25T06:00:00.000Z",
      }),
    );
    expect(a).not.toBe(b);
    // For contrast, the pivot identity (with the period key) does
    // collapse the two — that is the precise lossiness the
    // analytics identity has to escape.
    const pivotA = normalizeFilterIdentity({
      filter: structured({ start: ISO_A_START, end: ISO_A_END }),
      period: "1h",
    });
    const pivotB = normalizeFilterIdentity({
      filter: structured({
        start: "2026-04-25T05:00:00.000Z",
        end: "2026-04-25T06:00:00.000Z",
      }),
      period: "1h",
    });
    expect(pivotA).toBe(pivotB);
  });

  it("returns the same identity for two structurally-identical filters", () => {
    const a = analyticsFilterIdentity(
      structured({
        start: ISO_A_START,
        end: ISO_A_END,
        kinds: ["HttpThreat"],
      }),
    );
    const b = analyticsFilterIdentity(
      structured({
        start: ISO_A_START,
        end: ISO_A_END,
        kinds: ["HttpThreat"],
      }),
    );
    expect(a).toBe(b);
  });
});

describe("normalizeFilterIdentityIgnoringTime — issue #429", () => {
  it("treats two filters with identical non-time fields but different ISO start/end as equal", () => {
    const a = normalizeFilterIdentityIgnoringTime(
      structured({
        start: ISO_A_START,
        end: ISO_A_END,
        kinds: ["HttpThreat"],
      }),
    );
    const b = normalizeFilterIdentityIgnoringTime(
      structured({
        start: "2099-01-01T00:00:00.000Z",
        end: "2099-01-01T01:00:00.000Z",
        kinds: ["HttpThreat"],
      }),
    );
    expect(a).toBe(b);
  });

  it("treats filters with different non-time fields as unequal even when start/end match", () => {
    const a = normalizeFilterIdentityIgnoringTime(
      structured({
        start: ISO_A_START,
        end: ISO_A_END,
        kinds: ["HttpThreat"],
      }),
    );
    const b = normalizeFilterIdentityIgnoringTime(
      structured({
        start: ISO_A_START,
        end: ISO_A_END,
        kinds: ["HttpThreat"],
        levels: ["HIGH"],
      }),
    );
    expect(a).not.toBe(b);
  });

  it("ignores period collapsing — two filters with identical non-time fields but different period values still match", () => {
    // The period key only enters the canonicalization through the
    // start/end stand-in; ignoring time means the period doesn't
    // matter either, just the non-time fields. So `Last 1 hour` and
    // `Last 1 day` over identical kinds are equal here even though
    // `normalizeFilterIdentity` would have reported them unequal.
    const a = normalizeFilterIdentityIgnoringTime(
      structured({
        start: ISO_A_START,
        end: ISO_A_END,
        kinds: ["HttpThreat"],
      }),
    );
    const b = normalizeFilterIdentityIgnoringTime(
      structured({
        start: "2026-04-20T00:00:00.000Z",
        end: "2026-04-25T00:00:00.000Z",
        kinds: ["HttpThreat"],
      }),
    );
    expect(a).toBe(b);
  });

  it("normalizes array order and deduplicates the same way the time-aware variant does", () => {
    const a = normalizeFilterIdentityIgnoringTime(
      structured({ kinds: ["HttpThreat", "DnsCovertChannel", "HttpThreat"] }),
    );
    const b = normalizeFilterIdentityIgnoringTime(
      structured({ kinds: ["DnsCovertChannel", "HttpThreat"] }),
    );
    expect(a).toBe(b);
  });

  it("compares query-mode filters by trimmed text", () => {
    const a = normalizeFilterIdentityIgnoringTime({
      mode: "query",
      text: " level:high ",
    });
    const b = normalizeFilterIdentityIgnoringTime({
      mode: "query",
      text: "level:high",
    });
    expect(a).toBe(b);
  });

  it("filtersAreEquivalentIgnoringTime composes the helpers", () => {
    expect(
      filtersAreEquivalentIgnoringTime(
        structured({
          start: ISO_A_START,
          end: ISO_A_END,
          kinds: ["HttpThreat"],
        }),
        structured({
          start: "2099-01-01T00:00:00.000Z",
          end: "2099-01-01T01:00:00.000Z",
          kinds: ["HttpThreat"],
        }),
      ),
    ).toBe(true);
    expect(
      filtersAreEquivalentIgnoringTime(
        structured({ kinds: ["HttpThreat"] }),
        structured({ kinds: ["DnsCovertChannel"] }),
      ),
    ).toBe(false);
  });
});
