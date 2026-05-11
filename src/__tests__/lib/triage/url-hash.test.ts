import { describe, expect, it } from "vitest";

import {
  parseTriagePivotHash,
  pivotHashFromTrail,
  replaceTriagePivotHash,
  serializeTriagePivotHash,
} from "@/lib/triage/url-hash";

describe("parseTriagePivotHash", () => {
  it("returns empty state for an empty / hash-only input", () => {
    expect(parseTriagePivotHash("")).toEqual({
      asset: null,
      steps: [],
      mode: null,
    });
    expect(parseTriagePivotHash("#")).toEqual({
      asset: null,
      steps: [],
      mode: null,
    });
  });

  it("parses an asset + dimension steps + mode (composite key)", () => {
    const state = parseTriagePivotHash(
      "#triage.pivot.asset=42%2F10.0.0.1" +
        "&triage.pivot.step=ja3%3Aabc123" +
        "&triage.pivot.step=country%3AUS" +
        "&triage.pivot.mode=tier2",
    );
    expect(state).toEqual({
      asset: { customerId: 42, address: "10.0.0.1" },
      steps: [
        { dimension: "ja3", valueKey: "abc123" },
        { dimension: "country", valueKey: "US" },
      ],
      mode: "tier2",
    });
  });

  it("ignores foreign keys (e.g. triage.strictness.*)", () => {
    const state = parseTriagePivotHash(
      "#triage.pivot.asset=42%2F10.0.0.1" +
        "&triage.strictness.level=high" +
        "&unrelated=value",
    );
    expect(state.asset).toEqual({ customerId: 42, address: "10.0.0.1" });
    expect(state.steps).toEqual([]);
    expect(state.mode).toBeNull();
  });

  it("treats a legacy single-component asset focus as customerId-null", () => {
    // URLs produced before 1B-3 wrote the bare address. Surface them
    // as `customerId: null` so the caller can render the stale-hash
    // toast rather than mis-resolving against the first customer's
    // matching address.
    const state = parseTriagePivotHash("#triage.pivot.asset=10.0.0.1");
    expect(state.asset).toEqual({ customerId: null, address: "10.0.0.1" });
  });

  it("rejects malformed asset focus encodings", () => {
    // Non-numeric customer prefix → stale.
    expect(
      parseTriagePivotHash("#triage.pivot.asset=foo%2F10.0.0.1").asset,
    ).toBeNull();
    // Empty address after slash → stale.
    expect(parseTriagePivotHash("#triage.pivot.asset=42%2F").asset).toBeNull();
    // Negative customer id → stale.
    expect(
      parseTriagePivotHash("#triage.pivot.asset=-1%2F10.0.0.1").asset,
    ).toBeNull();
  });

  it("drops malformed step entries", () => {
    const state = parseTriagePivotHash(
      "#triage.pivot.step=" +
        "&triage.pivot.step=unknownDim%3Aabc" +
        "&triage.pivot.step=ja3%3A" +
        "&triage.pivot.step=ja3%3Avalid",
    );
    expect(state.steps).toEqual([{ dimension: "ja3", valueKey: "valid" }]);
  });

  it("ignores invalid mode values", () => {
    const state = parseTriagePivotHash("#triage.pivot.mode=other");
    expect(state.mode).toBeNull();
  });

  it("decodes URI-encoded value keys (IPv6, special chars)", () => {
    const ipv6 = "fe80::1";
    const encoded = encodeURIComponent(`externalIp:${ipv6}`);
    const state = parseTriagePivotHash(`#triage.pivot.step=${encoded}`);
    expect(state.steps).toEqual([{ dimension: "externalIp", valueKey: ipv6 }]);
  });
});

describe("serializeTriagePivotHash", () => {
  it("omits empty fields", () => {
    const out = serializeTriagePivotHash({
      asset: null,
      steps: [],
      mode: null,
    });
    expect(out).toBe("");
  });

  it("encodes asset + steps + mode", () => {
    const out = serializeTriagePivotHash({
      asset: { customerId: 42, address: "10.0.0.1" },
      steps: [
        { dimension: "ja3", valueKey: "abc123" },
        { dimension: "country", valueKey: "US" },
      ],
      mode: "tier2",
    });
    expect(out).toBe(
      "triage.pivot.asset=42%2F10.0.0.1" +
        "&triage.pivot.step=ja3%3Aabc123" +
        "&triage.pivot.step=country%3AUS" +
        "&triage.pivot.mode=tier2",
    );
  });

  it("round-trips through parse", () => {
    const original = {
      asset: { customerId: 7, address: "192.168.1.7" },
      steps: [
        { dimension: "uriPattern" as const, valueKey: "/login?id=:n" },
        { dimension: "host" as const, valueKey: "example.com" },
      ],
      mode: "tier1" as const,
    };
    const encoded = serializeTriagePivotHash(original);
    expect(parseTriagePivotHash(`#${encoded}`)).toEqual(original);
  });
});

describe("pivotHashFromTrail", () => {
  it("collects asset + dimension steps in trail order", () => {
    const state = pivotHashFromTrail(
      [
        { kind: "asset", customerId: 42, address: "10.0.0.1" },
        {
          kind: "dimension",
          dimension: "ja3",
          value: { key: "abc123", label: "abc123" },
        },
        {
          kind: "dimension",
          dimension: "country",
          value: { key: "US", label: "US" },
        },
      ],
      "tier2",
    );
    expect(state).toEqual({
      asset: { customerId: 42, address: "10.0.0.1" },
      steps: [
        { dimension: "ja3", valueKey: "abc123" },
        { dimension: "country", valueKey: "US" },
      ],
      mode: "tier2",
    });
  });

  it("returns nulls when the trail is empty", () => {
    const state = pivotHashFromTrail([], null);
    expect(state).toEqual({ asset: null, steps: [], mode: null });
  });
});

describe("replaceTriagePivotHash", () => {
  it("preserves foreign keys while replacing pivot keys", () => {
    const next = replaceTriagePivotHash(
      "#triage.pivot.asset=old&triage.strictness.level=high",
      {
        asset: { customerId: 1, address: "10.0.0.2" },
        steps: [{ dimension: "ja3", valueKey: "x" }],
        mode: null,
      },
    );
    expect(next).toContain("triage.strictness.level=high");
    expect(next).toContain("triage.pivot.asset=1%2F10.0.0.2");
    expect(next).toContain("triage.pivot.step=ja3%3Ax");
    expect(next).not.toContain("triage.pivot.asset=old");
  });

  it("returns only foreign keys when the new state is empty", () => {
    const next = replaceTriagePivotHash(
      "#triage.strictness.level=high&triage.pivot.asset=stale",
      { asset: null, steps: [], mode: null },
    );
    expect(next).toBe("triage.strictness.level=high");
  });
});
