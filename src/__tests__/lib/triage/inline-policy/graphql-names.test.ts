import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CMP_KINDS,
  cmpKindToGraphql,
  RAW_EVENT_KINDS,
  RESPONSE_KINDS,
  rawEventKindToGraphql,
  responseKindToGraphql,
  THREAT_CATEGORIES,
  threatCategoryToGraphql,
  VALUE_KINDS,
  valueKindToGraphql,
} from "@/lib/triage/inline-policy";

/**
 * Round-trip guard: every literal accepted by the stored TriagePolicy
 * schema must translate to a name that exists in review-web's matching
 * GraphQL enum. A storage row that fails to translate would be invisible
 * to the engine, so the alignment is verified end-to-end against the
 * checked-in `schemas/review.graphql`.
 */

function readEnumMembers(enumName: string): Set<string> {
  const schemaPath = resolve(process.cwd(), "schemas/review.graphql");
  const text = readFileSync(schemaPath, "utf-8");
  const re = new RegExp(`enum\\s+${enumName}\\s*\\{([^}]*)\\}`);
  const match = re.exec(text);
  if (!match) throw new Error(`enum ${enumName} not found in review.graphql`);
  return new Set(
    match[1]
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => line.split(/\s+/)[0]),
  );
}

describe("inline-policy graphql-name translators", () => {
  it("maps every RAW_EVENT_KINDS literal to a GraphQL RawEventKind member", () => {
    const members = readEnumMembers("RawEventKind");
    for (const kind of RAW_EVENT_KINDS) {
      const graphql = rawEventKindToGraphql(kind);
      expect(members.has(graphql)).toBe(true);
    }
  });

  it("maps every VALUE_KINDS literal to a GraphQL ValueKind member", () => {
    const members = readEnumMembers("ValueKind");
    for (const kind of VALUE_KINDS) {
      const graphql = valueKindToGraphql(kind);
      expect(members.has(graphql)).toBe(true);
    }
  });

  it("maps every CMP_KINDS literal to a GraphQL AttrCmpKind member", () => {
    const members = readEnumMembers("AttrCmpKind");
    for (const kind of CMP_KINDS) {
      const graphql = cmpKindToGraphql(kind);
      expect(members.has(graphql)).toBe(true);
    }
  });

  it("maps every RESPONSE_KINDS literal to a GraphQL ResponseKind member", () => {
    const members = readEnumMembers("ResponseKind");
    for (const kind of RESPONSE_KINDS) {
      const graphql = responseKindToGraphql(kind);
      expect(members.has(graphql)).toBe(true);
    }
  });

  it("maps every THREAT_CATEGORIES literal to a GraphQL ThreatCategory member", () => {
    const members = readEnumMembers("ThreatCategory");
    for (const kind of THREAT_CATEGORIES) {
      const graphql = threatCategoryToGraphql(kind);
      expect(members.has(graphql)).toBe(true);
    }
  });

  it("rejects legacy match / not_match cmp kinds (now removed)", () => {
    // These literals existed in earlier rounds of this PR but are not
    // in `AttrCmpKind`. Asserting they're not in CMP_KINDS guards
    // against re-introduction.
    expect((CMP_KINDS as readonly string[]).includes("match")).toBe(false);
    expect((CMP_KINDS as readonly string[]).includes("not_match")).toBe(false);
  });
});
