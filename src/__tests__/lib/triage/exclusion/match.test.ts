import { describe, expect, it } from "vitest";
import type {
  ActiveExclusionSet,
  NormalizedEventColumns,
} from "@/lib/triage/exclusion";
import { isExcluded } from "@/lib/triage/exclusion";

function cols(
  overrides: Partial<NormalizedEventColumns> = {},
): NormalizedEventColumns {
  return {
    origAddr: null,
    respAddr: null,
    host: null,
    dnsQuery: null,
    uri: null,
    ...overrides,
  };
}

function active(set: ActiveExclusionSet["rules"]): ActiveExclusionSet {
  return { rules: set };
}

describe("isExcluded — IpAddress (CIDR / range / exact host)", () => {
  it("matches an exact host IP", () => {
    expect(
      isExcluded(
        cols({ origAddr: "10.0.0.5" }),
        active([
          { ipAddress: { hosts: ["10.0.0.5"], networks: [], ranges: [] } },
        ]),
      ),
    ).toBe(true);
  });

  it("matches a CIDR network", () => {
    expect(
      isExcluded(
        cols({ origAddr: "10.0.0.42" }),
        active([
          { ipAddress: { hosts: [], networks: ["10.0.0.0/24"], ranges: [] } },
        ]),
      ),
    ).toBe(true);
    expect(
      isExcluded(
        cols({ origAddr: "10.0.1.42" }),
        active([
          { ipAddress: { hosts: [], networks: ["10.0.0.0/24"], ranges: [] } },
        ]),
      ),
    ).toBe(false);
  });

  it("matches an inclusive range", () => {
    expect(
      isExcluded(
        cols({ respAddr: "10.0.0.10" }),
        active([
          {
            ipAddress: {
              hosts: [],
              networks: [],
              ranges: [{ start: "10.0.0.5", end: "10.0.0.20" }],
            },
          },
        ]),
      ),
    ).toBe(true);
    expect(
      isExcluded(
        cols({ respAddr: "10.0.0.21" }),
        active([
          {
            ipAddress: {
              hosts: [],
              networks: [],
              ranges: [{ start: "10.0.0.5", end: "10.0.0.20" }],
            },
          },
        ]),
      ),
    ).toBe(false);
  });

  it("matches IPv6 CIDR", () => {
    expect(
      isExcluded(
        cols({ origAddr: "2001:db8:abcd::1" }),
        active([
          { ipAddress: { hosts: [], networks: ["2001:db8::/32"], ranges: [] } },
        ]),
      ),
    ).toBe(true);
  });

  it("does not match across IPv4 / IPv6 families", () => {
    expect(
      isExcluded(
        cols({ origAddr: "10.0.0.5" }),
        active([{ ipAddress: { hosts: [], networks: ["::/0"], ranges: [] } }]),
      ),
    ).toBe(false);
  });
});

describe("isExcluded — Hostname / Uri (exact)", () => {
  it("Hostname matches host column exactly only", () => {
    expect(
      isExcluded(
        cols({ host: "internal.example" }),
        active([{ hostname: ["internal.example"] }]),
      ),
    ).toBe(true);
    expect(
      isExcluded(
        cols({ host: "internal.example.com" }),
        active([{ hostname: ["internal.example"] }]),
      ),
    ).toBe(false);
  });

  it("Uri matches uri column exactly only", () => {
    expect(
      isExcluded(cols({ uri: "/health" }), active([{ uri: ["/health"] }])),
    ).toBe(true);
    expect(
      isExcluded(
        cols({ uri: "/health/check" }),
        active([{ uri: ["/health"] }]),
      ),
    ).toBe(false);
  });
});

describe("isExcluded — Domain (regex on host + dns_query, never uri)", () => {
  it("matches host via Rust ∩ JS regex", () => {
    expect(
      isExcluded(
        cols({ host: "ads.example.net" }),
        active([{ domain: ["\\.example\\.net$"] }]),
      ),
    ).toBe(true);
  });

  it("matches dnsQuery via Rust ∩ JS regex", () => {
    expect(
      isExcluded(
        cols({ dnsQuery: "tracker.example.org" }),
        active([{ domain: ["^tracker\\."] }]),
      ),
    ).toBe(true);
  });

  it("does NOT match uri (Domain → host + dns_query only)", () => {
    expect(
      isExcluded(
        cols({ uri: "https://ads.example.net/path" }),
        active([{ domain: ["\\.example\\.net"] }]),
      ),
    ).toBe(false);
  });
});

describe("isExcluded — engine-boundary regex patterns", () => {
  // The intersection grammar rejects engine-divergent constructs at
  // INSERT time. The matcher itself throws if asked to compile one,
  // so the cadence runner cannot silently match different things in
  // Rust and JS.

  it("rejects (?i) inline modifier", () => {
    expect(() =>
      isExcluded(
        cols({ host: "x.example" }),
        active([{ domain: ["(?i)example"] }]),
      ),
    ).toThrow(/Inline modifier flags/);
  });

  it("rejects \\A / \\z anchors", () => {
    expect(() =>
      isExcluded(
        cols({ host: "x.example" }),
        active([{ domain: ["\\Aexample\\z"] }]),
      ),
    ).toThrow(/anchors are rejected/);
  });

  it("rejects lookbehind", () => {
    expect(() =>
      isExcluded(
        cols({ host: "x.example" }),
        active([{ domain: ["(?<=foo)example"] }]),
      ),
    ).toThrow(/Lookbehind/);
  });

  it("rejects lookahead", () => {
    expect(() =>
      isExcluded(
        cols({ host: "x.example" }),
        active([{ domain: ["(?=foo)example"] }]),
      ),
    ).toThrow(/Lookahead/);
  });

  it("rejects back-references", () => {
    expect(() =>
      isExcluded(
        cols({ host: "x.example" }),
        active([{ domain: ["(foo)\\1"] }]),
      ),
    ).toThrow(/Back-references/);
  });
});

describe("isExcluded — short-circuit / OR semantics", () => {
  it("matches when ANY rule in the active set matches", () => {
    expect(
      isExcluded(
        cols({ host: "ok.example" }),
        active([{ hostname: ["other.example"] }, { hostname: ["ok.example"] }]),
      ),
    ).toBe(true);
  });

  it("returns false when no rule matches", () => {
    expect(
      isExcluded(
        cols({ host: "neither.example" }),
        active([{ hostname: ["other.example"] }, { uri: ["/admin"] }]),
      ),
    ).toBe(false);
  });

  it("empty rule set is a pass-through (every event survives)", () => {
    expect(
      isExcluded(cols({ origAddr: "10.0.0.1", host: "x" }), active([])),
    ).toBe(false);
  });
});
