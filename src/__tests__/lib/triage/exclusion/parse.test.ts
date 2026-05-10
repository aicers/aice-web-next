import { describe, expect, it } from "vitest";

import {
  computeExclusionsFingerprint,
  ExclusionInputParseError,
  parseExclusionInput,
  parseExclusionInputs,
} from "@/lib/triage/exclusion";

describe("parseExclusionInput — single EventTriageExclusionInput", () => {
  it("parses a populated ipAddress with hosts / networks / ranges", () => {
    const rules = parseExclusionInput({
      ipAddress: {
        hosts: ["10.0.0.1"],
        networks: ["10.0.0.0/24"],
        ranges: [{ start: "10.1.0.0", end: "10.1.0.255" }],
      },
    });
    expect(rules).toHaveLength(1);
    expect(rules[0].ipAddress).toEqual({
      hosts: ["10.0.0.1"],
      networks: ["10.0.0.0/24"],
      ranges: [{ start: "10.1.0.0", end: "10.1.0.255" }],
    });
  });

  it("flattens multi-field input into one rule per populated field", () => {
    const rules = parseExclusionInput({
      domain: ["ads\\.example\\.com"],
      hostname: ["safe.example.com"],
      uri: ["/health"],
    });
    expect(rules).toHaveLength(3);
    const domainRule = rules.find((r) => r.domain !== undefined);
    const hostnameRule = rules.find((r) => r.hostname !== undefined);
    const uriRule = rules.find((r) => r.uri !== undefined);
    expect(domainRule?.domain).toEqual(["ads\\.example\\.com"]);
    expect(hostnameRule?.hostname).toEqual(["safe.example.com"]);
    expect(uriRule?.uri).toEqual(["/health"]);
    // Each flattened rule is single-field — none carries a sibling.
    for (const rule of rules) {
      const populated = [
        rule.ipAddress,
        rule.domain,
        rule.hostname,
        rule.uri,
      ].filter((x) => x !== undefined);
      expect(populated).toHaveLength(1);
    }
  });

  it("drops empty strings from hostname / uri lists", () => {
    const rules = parseExclusionInput({
      hostname: ["a.example.com", ""],
      uri: ["", "/path"],
    });
    expect(rules).toHaveLength(2);
    expect(rules.find((r) => r.hostname)?.hostname).toEqual(["a.example.com"]);
    expect(rules.find((r) => r.uri)?.uri).toEqual(["/path"]);
  });

  it("rejects an empty exclusion (no populated field)", () => {
    expect(() => parseExclusionInput({})).toThrow(ExclusionInputParseError);
    expect(() =>
      parseExclusionInput({
        ipAddress: null,
        domain: null,
        hostname: null,
        uri: null,
      }),
    ).toThrow(/at least one populated field/);
  });

  it("rejects an ipAddress group with no hosts / networks / ranges", () => {
    expect(() =>
      parseExclusionInput({
        ipAddress: { hosts: [], networks: [], ranges: [] },
      }),
    ).toThrow(/at least one of hosts \/ networks \/ ranges/);
  });

  it("rejects an invalid Domain pattern at the persistence boundary", () => {
    expect(() =>
      parseExclusionInput({ domain: ["host\\d+\\.example"] }),
    ).toThrow(/Shorthand \\d is rejected/);
    expect(() =>
      parseExclusionInput({ domain: ["(?i)case-insensitive"] }),
    ).toThrow(/Inline modifier flags/);
  });

  it("threads the index into the error so storage CRUD can highlight the bad row", () => {
    try {
      parseExclusionInputs([{ hostname: ["ok"] }, { domain: ["(?<=foo)bar"] }]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExclusionInputParseError);
      expect((err as ExclusionInputParseError).index).toBe(1);
      expect((err as Error).message).toMatch(/exclusions\[1\]/);
    }
  });
});

describe("parseExclusionInputs — list", () => {
  it("returns [] for null / undefined", () => {
    expect(parseExclusionInputs(null)).toEqual([]);
    expect(parseExclusionInputs(undefined)).toEqual([]);
  });

  it("parses each element through parseExclusionInput", () => {
    const rules = parseExclusionInputs([
      { hostname: ["a.example"] },
      { uri: ["/health"] },
    ]);
    expect(rules).toHaveLength(2);
    expect(rules[0].hostname).toEqual(["a.example"]);
    expect(rules[1].uri).toEqual(["/health"]);
  });

  it("grouped and split inputs produce the same fingerprint after parsing", () => {
    const grouped = parseExclusionInputs([
      { hostname: ["a.example"], uri: ["/health"] },
    ]);
    const split = parseExclusionInputs([
      { hostname: ["a.example"] },
      { uri: ["/health"] },
    ]);
    expect(computeExclusionsFingerprint(grouped)).toBe(
      computeExclusionsFingerprint(split),
    );
  });
});
