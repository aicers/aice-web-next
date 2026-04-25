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
