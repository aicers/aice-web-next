import "server-only";

import { getAimerIntegrationSettings } from "./settings";
import { hasActiveAimerSigningKey } from "./signing-key";

// ── Types ───────────────────────────────────────────────────────

export interface AimerIntegrationSetup {
  aiceId: string | null;
  bridgeUrl: string | null;
  defaultModelName: string | null;
  defaultModel: string | null;
  hasActiveSigningKey: boolean;
}

export type AimerIntegrationMissingReason =
  | "aiceId"
  | "bridgeUrl"
  | "defaultModelName"
  | "defaultModel"
  | "signingKey";

export interface AimerIntegrationSetupStatus {
  configured: boolean;
  missingReasons?: AimerIntegrationMissingReason[];
}

// ── Helpers ─────────────────────────────────────────────────────

function deriveMissing(
  setup: AimerIntegrationSetup,
): AimerIntegrationMissingReason[] {
  const missing: AimerIntegrationMissingReason[] = [];
  if (!setup.aiceId) missing.push("aiceId");
  if (!setup.bridgeUrl) missing.push("bridgeUrl");
  if (!setup.defaultModelName) missing.push("defaultModelName");
  if (!setup.defaultModel) missing.push("defaultModel");
  if (!setup.hasActiveSigningKey) missing.push("signingKey");
  return missing;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Read the three system-wide Aimer integration prerequisites for
 * admin-screen / server-internal consumers.  Returns the full setting
 * values so the admin page can render the editable fields and the
 * key-rotation lifecycle.  Never exposes the private signing key.
 */
export async function getAimerIntegrationSetup(): Promise<AimerIntegrationSetup> {
  const [
    { aiceId, bridgeUrl, defaultModelName, defaultModel },
    hasActiveSigningKey,
  ] = await Promise.all([
    getAimerIntegrationSettings(),
    Promise.resolve(hasActiveAimerSigningKey()),
  ]);
  return {
    aiceId,
    bridgeUrl,
    defaultModelName,
    defaultModel,
    hasActiveSigningKey,
  };
}

/**
 * Minimum-disclosure variant for Sub-7.2.E (#440)'s event-detail
 * server component.  Returns only `{ configured }` plus the list of
 * missing prerequisites — the actual `aiceId`, `bridgeUrl`, and
 * signing-key existence flag never enter the consumer's render path.
 *
 * Both helpers wrap the same underlying read; this variant exists so
 * downstream pages can honor the #440 minimum-disclosure rule when
 * passing props to client components.
 */
export async function getAimerIntegrationSetupStatus(): Promise<AimerIntegrationSetupStatus> {
  const setup = await getAimerIntegrationSetup();
  const missingReasons = deriveMissing(setup);
  if (missingReasons.length === 0) {
    return { configured: true };
  }
  return { configured: false, missingReasons };
}

/** Pure helper exposed for tests covering the derivation. */
export function deriveAimerIntegrationSetupStatus(
  setup: AimerIntegrationSetup,
): AimerIntegrationSetupStatus {
  const missingReasons = deriveMissing(setup);
  if (missingReasons.length === 0) {
    return { configured: true };
  }
  return { configured: false, missingReasons };
}
