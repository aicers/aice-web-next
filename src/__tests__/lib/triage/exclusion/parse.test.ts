import { describe, expect, it } from "vitest";

import {
  ExclusionInputParseError,
  parseExclusionInput,
  parseExclusionInputs,
} from "@/lib/triage/exclusion";

describe("parseExclusionInput — single EventTriageExclusionInput", () => {
  it("parses a populated ipAddress with hosts / networks / ranges", () => {
    const rule = parseExclusionInput({
      ipAddress: {
        hosts: ["10.0.0.1"],
        networks: ["10.0.0.0/24"],
        ranges: [{ start: "10.1.0.0", end: "10.1.0.255" }],
      },
    });
    expect(rule.ipAddress).toEqual({
      hosts: ["10.0.0.1"],
      networks: ["10.0.0.0/24"],
      ranges: [{ start: "10.1.0.0", end: "10.1.0.255" }],
    });
  });

  it("parses domain / hostname / uri lists", () => {
    const rule = parseExclusionInput({
      domain: ["ads\\.example\\.com"],
      hostname: ["safe.example.com"],
      uri: ["/health"],
    });
    expect(rule.domain).toEqual(["ads\\.example\\.com"]);
    expect(rule.hostname).toEqual(["safe.example.com"]);
    expect(rule.uri).toEqual(["/health"]);
  });

  it("drops empty strings from hostname / uri lists", () => {
    const rule = parseExclusionInput({
      hostname: ["a.example.com", ""],
      uri: ["", "/path"],
    });
    expect(rule.hostname).toEqual(["a.example.com"]);
    expect(rule.uri).toEqual(["/path"]);
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
});
