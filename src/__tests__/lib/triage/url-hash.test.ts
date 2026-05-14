import { describe, expect, it } from "vitest";

import {
  parseTriagePivotHash,
  parseTriageStoriesHash,
  pivotHashFromTrail,
  replaceTriagePivotHash,
  replaceTriageStoriesHash,
  serializeTriagePivotHash,
  serializeTriageStoriesHash,
} from "@/lib/triage/url-hash";

describe("parseTriagePivotHash", () => {
  it("returns empty state for an empty / hash-only input", () => {
    expect(parseTriagePivotHash("")).toEqual({
      asset: null,
      steps: [],
      mode: null,
      rejectedStepCount: 0,
    });
    expect(parseTriagePivotHash("#")).toEqual({
      asset: null,
      steps: [],
      mode: null,
      rejectedStepCount: 0,
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
      rejectedStepCount: 0,
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
    expect(state.rejectedStepCount).toBe(0);
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

  it("drops malformed step entries and reports them via rejectedStepCount", () => {
    const state = parseTriagePivotHash(
      "#triage.pivot.step=" +
        "&triage.pivot.step=unknownDim%3Aabc" +
        "&triage.pivot.step=ja3%3A" +
        "&triage.pivot.step=ja3%3Avalid",
    );
    expect(state.steps).toEqual([{ dimension: "ja3", valueKey: "valid" }]);
    // Three present-but-rejected step segments: empty value, unknown
    // dimension, and empty value-key after the colon. The caller uses
    // this signal to surface the stale-hash toast (#498).
    expect(state.rejectedStepCount).toBe(3);
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

  it("accepts the two enum values for the static learningMethods dimension", () => {
    // `LearningMethod` is a fixed two-value SDL enum; the parser
    // whitelists the literals so a shared URL using either value
    // round-trips like any other Tier-2-only step (#498).
    const state = parseTriagePivotHash(
      "#triage.pivot.step=" +
        encodeURIComponent("learningMethods:UNSUPERVISED") +
        "&triage.pivot.step=" +
        encodeURIComponent("learningMethods:SEMI_SUPERVISED") +
        "&triage.pivot.mode=tier2",
    );
    expect(state.steps).toEqual([
      { dimension: "learningMethods", valueKey: "UNSUPERVISED" },
      { dimension: "learningMethods", valueKey: "SEMI_SUPERVISED" },
    ]);
    expect(state.mode).toBe("tier2");
  });

  it("accepts free-form keywords values up to the max length", () => {
    // `keywords` (#499) has no whitelist — the parser passes the
    // typed string through and the panel's submit handler caps the
    // length at 256.
    const state = parseTriagePivotHash(
      `#triage.pivot.step=${encodeURIComponent("keywords:lateral movement")}`,
    );
    expect(state.steps).toEqual([
      { dimension: "keywords", valueKey: "lateral movement" },
    ]);
    expect(state.rejectedStepCount).toBe(0);
  });

  it("rejects keywords values longer than the 256-character cap", () => {
    // The submit handler rejects this client-side; the parser
    // enforces the same ceiling so a hand-crafted shared URL with an
    // oversized blob falls back to the asset root via the stale-hash
    // path rather than blowing up the LRU cache key.
    const tooLong = "a".repeat(257);
    const state = parseTriagePivotHash(
      `#triage.pivot.step=${encodeURIComponent(`keywords:${tooLong}`)}`,
    );
    expect(state.steps).toEqual([]);
    expect(state.rejectedStepCount).toBe(1);
  });

  it("round-trips per-protocol identifier dimensions (#503)", () => {
    // Without the KNOWN_DIMENSIONS extension a shared URL referencing
    // a per-protocol dimension would be silently dropped at parse
    // time as an unknown dimension. Spot-check the SSH HASSH and
    // FTP-command ids — the rest go through the same validation path.
    const state = parseTriagePivotHash(
      "#triage.pivot.step=" +
        encodeURIComponent("sshHassh:aabbccdd") +
        "&triage.pivot.step=" +
        encodeURIComponent("ftpCommand:RETR") +
        "&triage.pivot.step=" +
        encodeURIComponent("mqttSubscribe:sensors/+/temp"),
    );
    expect(state.steps).toEqual([
      { dimension: "sshHassh", valueKey: "aabbccdd" },
      { dimension: "ftpCommand", valueKey: "RETR" },
      { dimension: "mqttSubscribe", valueKey: "sensors/+/temp" },
    ]);
    expect(state.rejectedStepCount).toBe(0);
  });

  it("rejects learningMethods value keys outside the SDL enum", () => {
    // A typo'd or schema-changed enum literal must drop the step
    // rather than reach the Tier 2 fetch path — REview would otherwise
    // return a generic GraphQL error and the operator would not see
    // the stale-hash toast (#498 negative-path requirement).
    const state = parseTriagePivotHash(
      "#triage.pivot.step=" +
        encodeURIComponent("learningMethods:INVALID_VALUE") +
        "&triage.pivot.step=" +
        encodeURIComponent("learningMethods:unsupervised") +
        "&triage.pivot.step=" +
        encodeURIComponent("learningMethods:UNSUPERVISED"),
    );
    expect(state.steps).toEqual([
      { dimension: "learningMethods", valueKey: "UNSUPERVISED" },
    ]);
    // The two whitelist misses are reported so the restore path can
    // distinguish "no step in URL" from "step was present but the
    // static-options whitelist rejected it" and trigger the stale-hash
    // toast for the latter.
    expect(state.rejectedStepCount).toBe(2);
  });
});

describe("serializeTriagePivotHash", () => {
  it("omits empty fields", () => {
    const out = serializeTriagePivotHash({
      asset: null,
      steps: [],
      mode: null,
      rejectedStepCount: 0,
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
      rejectedStepCount: 0,
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
      rejectedStepCount: 0,
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
      rejectedStepCount: 0,
    });
  });

  it("returns nulls when the trail is empty", () => {
    const state = pivotHashFromTrail([], null);
    expect(state).toEqual({
      asset: null,
      steps: [],
      mode: null,
      rejectedStepCount: 0,
    });
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
        rejectedStepCount: 0,
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
      { asset: null, steps: [], mode: null, rejectedStepCount: 0 },
    );
    expect(next).toBe("triage.strictness.level=high");
  });
});

/**
 * #490 acceptance: "URL hash carries `(customerId, storyId)` in both
 * cases; reloading the page restores the focused Story by composite
 * key (single-id legacy hash falls back to the list root with the
 * documented toast)."
 */
describe("parseTriageStoriesHash", () => {
  it("parses `triage.tab=stories` and a composite story focus", () => {
    expect(
      parseTriageStoriesHash("#triage.tab=stories&triage.story=42%2F7"),
    ).toEqual({
      tab: "stories",
      story: { customerId: 42, storyId: "7" },
      storyStaleHash: false,
    });
  });

  it("flags a bare storyId (legacy single-id form) as stale", () => {
    // `event_group.id` is BIGSERIAL per tenant DB — without
    // `customerId/` the focus cannot resolve unambiguously.
    const parsed = parseTriageStoriesHash("#triage.story=7");
    expect(parsed.story).toBeNull();
    expect(parsed.storyStaleHash).toBe(true);
  });

  it("flags non-numeric customerId as stale", () => {
    expect(parseTriageStoriesHash("#triage.story=abc%2F7").storyStaleHash).toBe(
      true,
    );
  });

  it("flags non-numeric storyId as stale", () => {
    expect(
      parseTriageStoriesHash("#triage.story=42%2Fabc").storyStaleHash,
    ).toBe(true);
  });

  it("ignores foreign keys (triage.pivot.*, triage.strictness.*)", () => {
    expect(
      parseTriageStoriesHash(
        "#triage.pivot.asset=1%2F10.0.0.1&triage.strictness.level=high",
      ),
    ).toEqual({ tab: null, story: null, storyStaleHash: false });
  });

  it("rejects unknown tab ids without surfacing the stale-hash flag", () => {
    expect(parseTriageStoriesHash("#triage.tab=ghost")).toEqual({
      tab: null,
      story: null,
      storyStaleHash: false,
    });
  });
});

describe("serializeTriageStoriesHash", () => {
  it("emits both keys when both are set", () => {
    expect(
      serializeTriageStoriesHash({
        tab: "stories",
        story: { customerId: 42, storyId: "7" },
        storyStaleHash: false,
      }),
    ).toBe("triage.tab=stories&triage.story=42%2F7");
  });

  it("omits the story key when the focus is null", () => {
    expect(
      serializeTriageStoriesHash({
        tab: "stories",
        story: null,
        storyStaleHash: false,
      }),
    ).toBe("triage.tab=stories");
  });

  it("omits the story key when customerId is null (never serializes legacy bare-id)", () => {
    expect(
      serializeTriageStoriesHash({
        tab: "stories",
        story: { customerId: null, storyId: "7" },
        storyStaleHash: false,
      }),
    ).toBe("triage.tab=stories");
  });

  it("returns an empty string when both fields are absent", () => {
    expect(
      serializeTriageStoriesHash({
        tab: null,
        story: null,
        storyStaleHash: false,
      }),
    ).toBe("");
  });
});

describe("replaceTriageStoriesHash", () => {
  it("preserves foreign keys (triage.pivot.*) while updating story keys", () => {
    const next = replaceTriageStoriesHash(
      "#triage.pivot.asset=1%2F10.0.0.1&triage.tab=pivot&triage.story=99%2F1",
      {
        tab: "stories",
        story: { customerId: 42, storyId: "7" },
        storyStaleHash: false,
      },
    );
    expect(next).toContain("triage.pivot.asset=1%2F10.0.0.1");
    expect(next).toContain("triage.tab=stories");
    expect(next).toContain("triage.story=42%2F7");
    expect(next).not.toContain("triage.tab=pivot");
    expect(next).not.toContain("triage.story=99%2F1");
  });
});
