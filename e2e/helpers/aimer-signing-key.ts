import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { exportJWK, generateKeyPair } from "jose";

/**
 * Resolve the on-disk path the Aimer signing-key facade reads at SSR
 * time. Mirrors `getDataDir()` + `keysDir()` in
 * `src/lib/aimer/signing-key.ts` so the e2e harness can create the file
 * the application will pick up without touching the `server-only`
 * module from a test context.
 */
function keyFilePath(): string {
  const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.resolve(process.cwd(), "data");
  return [dataDir, "keys", "aimer-context-signing.json"].join(path.sep);
}

/**
 * Write a minimal `aimer-context-signing.json` so
 * `hasActiveAimerSigningKey()` returns `true` and the event-investigation
 * page renders the Send to Aimer button in the enabled state. The
 * private key is genuine — generated with `jose` — so subsequent
 * envelope signing also works if the screenshot flow ever goes through
 * the real signing path. Idempotent: a no-op when the file already
 * exists.
 */
export async function ensureAimerSigningKey(): Promise<void> {
  const target = keyFilePath();
  if (existsSync(target)) return;

  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const kid = randomUUID();
  const privateJwk = await exportJWK(privateKey);
  const publicJwk = await exportJWK(publicKey);
  privateJwk.kid = kid;
  publicJwk.kid = kid;

  const now = new Date();
  const rotation = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

  const content = JSON.stringify(
    {
      active: {
        kid,
        algorithm: "ES256",
        privateKey: privateJwk,
        publicKey: publicJwk,
        createdAt: now.toISOString(),
        recommendedRotationAt: rotation.toISOString(),
      },
    },
    null,
    2,
  );

  const dir = path.dirname(target);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort on platforms that don't honor POSIX perms
  }
  writeFileSync(target, content, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(target, 0o600);
  } catch {
    // best-effort
  }
}

export function clearAimerSigningKey(): void {
  const target = keyFilePath();
  try {
    unlinkSync(target);
  } catch {
    // file may not exist — ignore
  }
}
