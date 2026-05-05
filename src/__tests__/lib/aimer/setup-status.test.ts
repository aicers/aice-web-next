import { describe, expect, it } from "vitest";

import { deriveAimerIntegrationSetupStatus } from "@/lib/aimer/setup-status";

describe("deriveAimerIntegrationSetupStatus", () => {
  it("reports configured when all three prerequisites are present", () => {
    expect(
      deriveAimerIntegrationSetupStatus({
        aiceId: "aice.example.com",
        bridgeUrl: "https://aimer.example.com",
        hasActiveSigningKey: true,
      }),
    ).toEqual({ configured: true });
  });

  it("flags every missing prerequisite (aiceId, bridgeUrl, signingKey)", () => {
    const status = deriveAimerIntegrationSetupStatus({
      aiceId: null,
      bridgeUrl: null,
      hasActiveSigningKey: false,
    });
    expect(status.configured).toBe(false);
    expect(status.missingReasons).toEqual([
      "aiceId",
      "bridgeUrl",
      "signingKey",
    ]);
  });

  it("flags only aiceId when bridgeUrl and signingKey are present", () => {
    const status = deriveAimerIntegrationSetupStatus({
      aiceId: null,
      bridgeUrl: "https://aimer.example.com",
      hasActiveSigningKey: true,
    });
    expect(status).toEqual({ configured: false, missingReasons: ["aiceId"] });
  });

  it("flags only bridgeUrl when aiceId and signingKey are present", () => {
    const status = deriveAimerIntegrationSetupStatus({
      aiceId: "aice.example.com",
      bridgeUrl: null,
      hasActiveSigningKey: true,
    });
    expect(status).toEqual({
      configured: false,
      missingReasons: ["bridgeUrl"],
    });
  });

  it("flags only signingKey when both settings are present", () => {
    const status = deriveAimerIntegrationSetupStatus({
      aiceId: "aice.example.com",
      bridgeUrl: "https://aimer.example.com",
      hasActiveSigningKey: false,
    });
    expect(status).toEqual({
      configured: false,
      missingReasons: ["signingKey"],
    });
  });

  it("does not include customer external_key in the derivation", () => {
    // Sanity guard: the helper takes only the three system-wide
    // prerequisites; per-customer external_key is intentionally
    // outside its surface so that an issue #440 callsite cannot
    // accidentally leak per-customer state into the system-wide
    // configured/not-configured signal.
    const status = deriveAimerIntegrationSetupStatus({
      aiceId: "aice.example.com",
      bridgeUrl: "https://aimer.example.com",
      hasActiveSigningKey: true,
    });
    expect(status.configured).toBe(true);
    expect(status.missingReasons).toBeUndefined();
  });
});
