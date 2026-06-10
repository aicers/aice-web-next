import { describe, expect, it } from "vitest";

import {
  parseTriagePivotHash,
  parseTriageStoriesHash,
  parseTriageStrictnessHash,
  pivotHashFromTrail,
  replaceTriagePivotHash,
  replaceTriageStoriesHash,
  replaceTriageStrictnessHash,
  serializeTriagePivotHash,
  serializeTriageStoriesHash,
} from "@/lib/triage/url-hash";

describe("parseTriagePivotHash", () => {
  it("returns empty state for an empty / hash-only input", () => {
    expect(parseTriagePivotHash("")).toEqual({
      asset: null,
      story: null,
      steps: [],
      mode: null,
      rejectedStepCount: 0,
      storyOriginStaleHash: false,
    });
    expect(parseTriagePivotHash("#")).toEqual({
      asset: null,
      story: null,
      steps: [],
      mode: null,
      rejectedStepCount: 0,
      storyOriginStaleHash: false,
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
      story: null,
      steps: [
        { dimension: "ja3", valueKey: "abc123" },
        { dimension: "country", valueKey: "US" },
      ],
      mode: "tier2",
      rejectedStepCount: 0,
      storyOriginStaleHash: false,
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

  it("rejects malformed asset focus encodings", () => {
    // Bare address with no `customerId/` prefix → stale, rather than
    // mis-resolving against the first customer's matching address.
    expect(
      parseTriagePivotHash("#triage.pivot.asset=10.0.0.1").asset,
    ).toBeNull();
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

  it("parses the Story-origin marker (#553)", () => {
    // The Pivot-origin marker survives a Stories↔Pivot tab swap and
    // travels alongside the standard pivot keys. A bare `triage.story`
    // value is the Stories-tab focus (cleared on swap by design) — it
    // is parsed by `parseTriageStoriesHash`, not here.
    const state = parseTriagePivotHash(
      "#triage.pivot.story=42%2F7" +
        "&triage.pivot.step=" +
        encodeURIComponent("host:example.com"),
    );
    expect(state.story).toEqual({ customerId: 42, storyId: "7" });
    expect(state.steps).toEqual([
      { dimension: "host", valueKey: "example.com" },
    ]);
    expect(state.storyOriginStaleHash).toBe(false);
  });

  it("flags malformed Story-origin markers as stale", () => {
    // Same rules as `parseTriageStoriesHash`'s `parseStoryFocus`:
    // composite required, both halves numeric, customerId non-negative.
    expect(parseTriagePivotHash("#triage.pivot.story=7").story).toBeNull();
    expect(
      parseTriagePivotHash("#triage.pivot.story=7").storyOriginStaleHash,
    ).toBe(true);
    expect(
      parseTriagePivotHash("#triage.pivot.story=abc%2F7").storyOriginStaleHash,
    ).toBe(true);
    expect(
      parseTriagePivotHash("#triage.pivot.story=42%2Fabc").storyOriginStaleHash,
    ).toBe(true);
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
      story: null,
      steps: [],
      mode: null,
      rejectedStepCount: 0,
      storyOriginStaleHash: false,
    });
    expect(out).toBe("");
  });

  it("encodes asset + steps + mode", () => {
    const out = serializeTriagePivotHash({
      asset: { customerId: 42, address: "10.0.0.1" },
      story: null,
      steps: [
        { dimension: "ja3", valueKey: "abc123" },
        { dimension: "country", valueKey: "US" },
      ],
      mode: "tier2",
      rejectedStepCount: 0,
      storyOriginStaleHash: false,
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
      story: null,
      steps: [
        { dimension: "uriPattern" as const, valueKey: "/login?id=:n" },
        { dimension: "host" as const, valueKey: "example.com" },
      ],
      mode: "tier1" as const,
      rejectedStepCount: 0,
      storyOriginStaleHash: false,
    };
    const encoded = serializeTriagePivotHash(original);
    expect(parseTriagePivotHash(`#${encoded}`)).toEqual(original);
  });
});

describe("serializeTriagePivotHash with Story origin (#553)", () => {
  it("emits the Story-origin marker alongside dimension steps", () => {
    const out = serializeTriagePivotHash({
      asset: null,
      story: { customerId: 42, storyId: "7" },
      steps: [{ dimension: "host", valueKey: "example.com" }],
      mode: "tier1",
      rejectedStepCount: 0,
      storyOriginStaleHash: false,
    });
    expect(out).toBe(
      "triage.pivot.story=42%2F7" +
        "&triage.pivot.step=host%3Aexample.com" +
        "&triage.pivot.mode=tier1",
    );
  });

  it("round-trips Story-origin + steps through parse", () => {
    const original = {
      asset: null,
      story: { customerId: 42, storyId: "7" },
      steps: [
        {
          dimension: "host" as const,
          valueKey: "example.com",
        },
      ],
      mode: "tier1" as const,
      rejectedStepCount: 0,
      storyOriginStaleHash: false,
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
      story: null,
      steps: [
        { dimension: "ja3", valueKey: "abc123" },
        { dimension: "country", valueKey: "US" },
      ],
      mode: "tier2",
      rejectedStepCount: 0,
      storyOriginStaleHash: false,
    });
  });

  it("returns nulls when the trail is empty", () => {
    const state = pivotHashFromTrail([], null);
    expect(state).toEqual({
      asset: null,
      story: null,
      steps: [],
      mode: null,
      rejectedStepCount: 0,
      storyOriginStaleHash: false,
    });
  });
});

describe("replaceTriagePivotHash", () => {
  it("preserves foreign keys while replacing pivot keys", () => {
    const next = replaceTriagePivotHash(
      "#triage.pivot.asset=old&triage.strictness.level=high",
      {
        asset: { customerId: 1, address: "10.0.0.2" },
        story: null,
        steps: [{ dimension: "ja3", valueKey: "x" }],
        mode: null,
        rejectedStepCount: 0,
        storyOriginStaleHash: false,
      },
    );
    expect(next).toContain("triage.strictness.level=high");
    expect(next).toContain("triage.pivot.asset=1%2F10.0.0.2");
    expect(next).toContain("triage.pivot.step=ja3%3Ax");
    expect(next).not.toContain("triage.pivot.asset=old");
  });

  it("preserves the Story-origin marker on Stories tab swap (#553)", () => {
    // Acceptance: with a Pivot-from-Story trail active, manually
    // clicking the Stories peer tab and back must restore the same
    // Story origin in the breadcrumb — the marker survives the swap
    // even though the Stories tab's `triage.story` focus clears on
    // swap. Replacing the Story-tab keys must not touch
    // `triage.pivot.story`.
    const beforeSwap =
      "#triage.tab=pivot" +
      "&triage.pivot.story=42%2F7" +
      "&triage.pivot.step=host%3Aexample.com";
    const afterSwap = replaceTriageStoriesHash(beforeSwap, {
      tab: "stories",
      story: null,
      storyStaleHash: false,
    });
    expect(afterSwap).toContain("triage.pivot.story=42%2F7");
    expect(afterSwap).toContain("triage.pivot.step=host%3Aexample.com");
    // …and swapping back to the Pivot tab still carries the marker.
    const backToPivot = replaceTriageStoriesHash(afterSwap, {
      tab: "pivot",
      story: null,
      storyStaleHash: false,
    });
    expect(backToPivot).toContain("triage.pivot.story=42%2F7");
  });

  it("returns only foreign keys when the new state is empty", () => {
    const next = replaceTriagePivotHash(
      "#triage.strictness.level=high&triage.pivot.asset=stale",
      {
        asset: null,
        story: null,
        steps: [],
        mode: null,
        rejectedStepCount: 0,
        storyOriginStaleHash: false,
      },
    );
    expect(next).toBe("triage.strictness.level=high");
  });
});

/**
 * #490 acceptance: "URL hash carries `(customerId, storyId)` in both
 * cases; reloading the page restores the focused Story by composite
 * key (a bare single-id hash falls back to the list root with the
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

  it("flags a bare storyId (no customerId/ prefix) as stale", () => {
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

describe("parseTriageStrictnessHash", () => {
  it("returns null for empty hash", () => {
    expect(parseTriageStrictnessHash("")).toBeNull();
    expect(parseTriageStrictnessHash("#")).toBeNull();
  });

  it("returns the stop id when present", () => {
    expect(parseTriageStrictnessHash("#triage.strictness.stop=top5")).toBe(
      "top5",
    );
    expect(
      parseTriageStrictnessHash(
        "#triage.pivot.asset=1%2F10.0.0.1&triage.strictness.stop=top20",
      ),
    ).toBe("top20");
  });

  it("returns the raw value even for unknown ids — caller decides fallback", () => {
    expect(
      parseTriageStrictnessHash("#triage.strictness.stop=somethingNew"),
    ).toBe("somethingNew");
  });

  it("returns null when the strictness key is absent", () => {
    expect(parseTriageStrictnessHash("#triage.pivot.asset=1%2F10.0.0.1")).toBe(
      null,
    );
  });
});

describe("replaceTriageStrictnessHash", () => {
  it("inserts the strictness key while preserving foreign keys", () => {
    const next = replaceTriageStrictnessHash(
      "#triage.pivot.asset=1%2F10.0.0.1&triage.tab=pivot",
      "top5",
    );
    expect(next).toContain("triage.pivot.asset=1%2F10.0.0.1");
    expect(next).toContain("triage.tab=pivot");
    expect(next).toContain("triage.strictness.stop=top5");
  });

  it("replaces an existing strictness key, not duplicates it", () => {
    const next = replaceTriageStrictnessHash(
      "#triage.strictness.stop=top80&triage.tab=stories",
      "top5",
    );
    const occurrences = next.split("triage.strictness.stop=").length - 1;
    expect(occurrences).toBe(1);
    expect(next).toContain("triage.strictness.stop=top5");
    expect(next).toContain("triage.tab=stories");
  });

  it("clears the strictness key when stopId is null", () => {
    const next = replaceTriageStrictnessHash(
      "#triage.strictness.stop=top5&triage.tab=stories",
      null,
    );
    expect(next).not.toContain("triage.strictness.stop");
    expect(next).toBe("triage.tab=stories");
  });
});
