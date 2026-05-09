import { describe, expect, it } from "vitest";

import { COUNTRY_CODES } from "@/lib/detection/countries";
import {
  INITIAL_THREAT_KINDS,
  LEARNING_METHOD_VALUES,
  THREAT_CATEGORY_KEY_BY_VALUE,
  THREAT_CATEGORY_VALUES,
  THREAT_LEVEL_VALUES,
} from "@/lib/detection/filter-options";
import { CURATED_EVENT_TYPENAMES } from "@/lib/detection/types";

describe("filter-options", () => {
  it("threat level values surface the three canonical ThreatLevel enum members", () => {
    expect([...THREAT_LEVEL_VALUES]).toEqual(["LOW", "MEDIUM", "HIGH"]);
  });

  it("threat category values cover all fourteen enum members", () => {
    expect(THREAT_CATEGORY_VALUES).toHaveLength(14);
    const keys = THREAT_CATEGORY_VALUES.map(
      (v) => THREAT_CATEGORY_KEY_BY_VALUE[v],
    );
    expect(new Set(keys).size).toBe(14);
    expect(keys).toContain("RECONNAISSANCE");
    expect(keys).toContain("RESOURCE_DEVELOPMENT");
  });

  it("learning method values are the two schema members", () => {
    expect([...LEARNING_METHOD_VALUES]).toEqual([
      "UNSUPERVISED",
      "SEMI_SUPERVISED",
    ]);
  });

  it("initial threat kinds are non-empty and unique", () => {
    expect(INITIAL_THREAT_KINDS.length).toBeGreaterThan(0);
    expect(new Set(INITIAL_THREAT_KINDS).size).toBe(
      INITIAL_THREAT_KINDS.length,
    );
  });

  it("initial threat kinds match the canonical REview __typename tokens", () => {
    // The rest of the app submits these PascalCase tokens as
    // `EventListFilterInput.kinds` (see `locatorToEventListFilter`
    // in `src/lib/detection/server-actions.ts`). The Detection
    // drawer must use the same contract so a picked option actually
    // matches the documents REview returns.
    expect([...INITIAL_THREAT_KINDS]).toEqual([...CURATED_EVENT_TYPENAMES]);
    for (const kind of INITIAL_THREAT_KINDS) {
      expect(kind).toMatch(/^[A-Z][A-Za-z0-9]+$/);
    }
  });

  it("country codes are unique upper-case two-letter tokens", () => {
    for (const code of COUNTRY_CODES) {
      expect(code).toMatch(/^[A-Z]{2}$/);
    }
    expect(new Set(COUNTRY_CODES).size).toBe(COUNTRY_CODES.length);
  });

  it("country codes include REview sentinels XX and ZZ", () => {
    expect(COUNTRY_CODES).toContain("XX");
    expect(COUNTRY_CODES).toContain("ZZ");
  });

  it("country codes cover a representative sample of major ISO-3166 codes", () => {
    for (const code of [
      "US",
      "KR",
      "JP",
      "CN",
      "GB",
      "DE",
      "FR",
      "BR",
      "IN",
      "AU",
    ]) {
      expect(COUNTRY_CODES).toContain(code);
    }
  });
});
