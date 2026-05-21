import { describe, expect, it } from "vitest";

import { deriveAimerIntegrationSetupStatus } from "@/lib/aimer/setup-status";

const FULLY_CONFIGURED = {
  aiceId: "aice.example.com",
  bridgeUrl: "https://aimer.example.com",
  defaultModelName: "anthropic",
  defaultModel: "claude-sonnet-4-6",
  hasActiveSigningKey: true,
};

describe("deriveAimerIntegrationSetupStatus", () => {
  it("reports configured when all five prerequisites are present", () => {
    expect(deriveAimerIntegrationSetupStatus(FULLY_CONFIGURED)).toEqual({
      configured: true,
    });
  });

  it("flags every missing prerequisite", () => {
    const status = deriveAimerIntegrationSetupStatus({
      aiceId: null,
      bridgeUrl: null,
      defaultModelName: null,
      defaultModel: null,
      hasActiveSigningKey: false,
    });
    expect(status.configured).toBe(false);
    expect(status.missingReasons).toEqual([
      "aiceId",
      "bridgeUrl",
      "defaultModelName",
      "defaultModel",
      "signingKey",
    ]);
  });

  it("flags only aiceId when the other prerequisites are present", () => {
    const status = deriveAimerIntegrationSetupStatus({
      ...FULLY_CONFIGURED,
      aiceId: null,
    });
    expect(status).toEqual({ configured: false, missingReasons: ["aiceId"] });
  });

  it("flags only bridgeUrl when the other prerequisites are present", () => {
    const status = deriveAimerIntegrationSetupStatus({
      ...FULLY_CONFIGURED,
      bridgeUrl: null,
    });
    expect(status).toEqual({
      configured: false,
      missingReasons: ["bridgeUrl"],
    });
  });

  it("flags only defaultModelName when the other prerequisites are present", () => {
    const status = deriveAimerIntegrationSetupStatus({
      ...FULLY_CONFIGURED,
      defaultModelName: null,
    });
    expect(status).toEqual({
      configured: false,
      missingReasons: ["defaultModelName"],
    });
  });

  it("flags only defaultModel when the other prerequisites are present", () => {
    const status = deriveAimerIntegrationSetupStatus({
      ...FULLY_CONFIGURED,
      defaultModel: null,
    });
    expect(status).toEqual({
      configured: false,
      missingReasons: ["defaultModel"],
    });
  });

  it("flags only signingKey when the other prerequisites are present", () => {
    const status = deriveAimerIntegrationSetupStatus({
      ...FULLY_CONFIGURED,
      hasActiveSigningKey: false,
    });
    expect(status).toEqual({
      configured: false,
      missingReasons: ["signingKey"],
    });
  });

  it("does not include customer external_key in the derivation", () => {
    const status = deriveAimerIntegrationSetupStatus(FULLY_CONFIGURED);
    expect(status.configured).toBe(true);
    expect(status.missingReasons).toBeUndefined();
  });
});
