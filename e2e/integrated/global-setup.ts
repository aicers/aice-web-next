import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Directory holding per-engine storage states and the cached aimer-
 * context signing key. Specs and the config-level sign-in setup
 * project derive concrete paths from {@link storageStatePath} so the
 * three engines stay isolated (each browser's session is bound to
 * its own UA fingerprint via `assessIpUaRisk` on the BFF — see
 * `src/lib/auth/guard.ts`).
 */
export const AUTH_DIR = resolve(__dirname, ".auth");

/**
 * Per-engine storageState path. The setup spec writes one of these
 * per `browserName`, and each main project's `use.storageState` reads
 * the matching one back. Keeping engines isolated lets firefox /
 * webkit pass the same authenticated scenarios as chromium without
 * the shared-state UA-fingerprint mismatch that previously forced
 * `test.skip(browserName !== "chromium")` gates throughout the spec.
 */
export function storageStatePath(browserName: string): string {
  return resolve(AUTH_DIR, `admin-storage-state-${browserName}.json`);
}

/**
 * Path to the aice-web-next aimer-context signing key (JWK) used by
 * the cross-binding tamper scenarios to re-sign `analyze_params_token`
 * after mutating a claim. The key is pulled out of the running BFF
 * container — without it the tampered JWS would fail the JWS-level
 * signature check on aimer-web instead of the `verifyAnalyzeParamsToken`
 * cross-binding check we want to exercise.
 */
export const SIGNING_KEY_PATH = resolve(AUTH_DIR, "aimer-context-signing.json");

/**
 * Command that prints the JSON contents of the signing key file from
 * the running aice-web-next container. The reference setup uses an
 * OrbStack VM (`orb -m m1`) wrapping docker; CI / alternative compose
 * stacks should set `SIGNING_KEY_FETCH_COMMAND` accordingly.
 */
const SIGNING_KEY_FETCH_COMMAND =
  process.env.SIGNING_KEY_FETCH_COMMAND ??
  "orb -m m1 docker exec aice-web-next-next-app-1 cat /app/data/keys/aimer-context-signing.json";

export default async function globalSetup(): Promise<void> {
  mkdirSync(AUTH_DIR, { recursive: true });

  // Pull the active signing key out of the BFF container so the
  // tamper specs can re-sign `analyze_params_token` after mutating
  // a cross-binding claim. Best-effort: a missing fetch command (or
  // an offline stack) leaves the file absent and the tamper specs
  // skip with a clear "signing key not provisioned" message.
  try {
    const parts = SIGNING_KEY_FETCH_COMMAND.split(/\s+/);
    const cmd = parts.shift();
    if (!cmd) throw new Error("empty SIGNING_KEY_FETCH_COMMAND");
    const keyJson = execFileSync(cmd, parts, { encoding: "utf8" });
    writeFileSync(SIGNING_KEY_PATH, keyJson);
  } catch (err) {
    console.warn(
      `global-setup: signing key fetch failed (${(err as Error).message}). Tamper specs will skip.`,
    );
  }
}
