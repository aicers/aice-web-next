import { describe, expect, it } from "vitest";

import {
  BASE_MODELS,
  isGsMode,
  NON_GS_ADDITIONAL_MODELS,
} from "@/lib/node/active-models";

describe("isGsMode", () => {
  it("treats only the documented truthy strings as gs-mode", () => {
    expect(isGsMode(undefined)).toBe(false);
    expect(isGsMode("")).toBe(false);
    expect(isGsMode("0")).toBe(false);
    expect(isGsMode("no")).toBe(false);
    expect(isGsMode("false")).toBe(false);
    expect(isGsMode("1")).toBe(true);
    expect(isGsMode("true")).toBe(true);
    expect(isGsMode("True")).toBe(true);
    expect(isGsMode("on")).toBe(true);
    expect(isGsMode("ON")).toBe(true);
  });
});

describe("model lists", () => {
  it("base list ships the 10 documented variants", () => {
    expect(BASE_MODELS.map((m) => m.id)).toEqual([
      "DnsCovertChannel",
      "TorConnection",
      "DomainGenerationAlgorithm",
      "FtpPlainText",
      "LdapPlainText",
      "CryptocurrencyMiningPool",
      "LockyRansomware",
      "SuspiciousTlsTraffic",
      "NonBrowser",
      "RepeatedHttpSessions",
    ]);
  });

  it("non-gs additional list contains the catalog blocklist + scan models", () => {
    const ids = NON_GS_ADDITIONAL_MODELS.map((m) => m.id);
    expect(ids).toContain("BlocklistDns");
    expect(ids).toContain("PortScan");
    expect(ids).toContain("UnusualDestinationPattern");
  });

  it("each variant carries a serde-snake-case wire value", () => {
    for (const model of [...BASE_MODELS, ...NON_GS_ADDITIONAL_MODELS]) {
      expect(model.wire).toMatch(/^[a-z][a-z ]*[a-z]$/);
    }
  });
});
