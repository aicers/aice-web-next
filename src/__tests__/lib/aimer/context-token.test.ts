import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const tmpDir = path.join(__dirname, ".tmp-aimer-context-token");
const dataDir = path.join(tmpDir, "data");

describe("aimer context-token signing", () => {
  let signingKey: typeof import("@/lib/aimer/signing-key");
  let mod: typeof import("@/lib/aimer/context-token");

  beforeEach(async () => {
    mkdirSync(dataDir, { recursive: true });
    process.env.DATA_DIR = dataDir;
    process.env.AIMER_SIGNING_KEY_PREV_RETENTION_MS = "0";
    signingKey = await import("@/lib/aimer/signing-key");
    mod = await import("@/lib/aimer/context-token");
    signingKey.deleteAimerSigningKeyFile();
    await signingKey.generateAimerSigningKey();
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    delete process.env.AIMER_SIGNING_KEY_PREV_RETENTION_MS;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function basePayload() {
    const iat = Math.floor(Date.now() / 1000);
    return {
      iss: "aice.example.com",
      aud: mod.AIMER_CONTEXT_TOKEN_AUDIENCE,
      sub: "account-1",
      aice_id: "aice.example.com",
      customer_ids: ["acmecorp.com"],
      iat,
      exp: iat + 60,
      jti: mod.generateContextTokenJti(),
    };
  }

  it("exports the canonical audience constant aimer-web verifies against", () => {
    expect(mod.AIMER_CONTEXT_TOKEN_AUDIENCE).toBe("aimer-web");
  });

  it("produces a JWS that round-trips through jose with the active kid header", async () => {
    const payload = basePayload();
    const jws = await mod.signContextToken(payload);

    const status = await signingKey.getAimerSigningKeyStatus();
    if (!status.active) throw new Error("expected active key");
    const header = decodeProtectedHeader(jws);
    expect(header.alg).toBe("ES256");
    expect(header.kid).toBe(status.active.kid);

    const verifyKey = await importJWK(
      status.active.publicJwk,
      status.active.algorithm,
    );
    const { payload: decoded } = await jwtVerify(jws, verifyKey, {
      issuer: payload.iss,
      audience: payload.aud,
    });
    expect(decoded.sub).toBe(payload.sub);
    expect(decoded.aice_id).toBe(payload.aice_id);
    expect(decoded.customer_ids).toEqual(payload.customer_ids);
    expect(decoded.iat).toBe(payload.iat);
    expect(decoded.exp).toBe(payload.exp);
    expect(decoded.jti).toBe(payload.jti);
  });

  it("generateContextTokenJti returns a fresh UUID each time", () => {
    const a = mod.generateContextTokenJti();
    const b = mod.generateContextTokenJti();
    expect(a).not.toBe(b);
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("throws when no active signing key is on disk", async () => {
    signingKey.deleteAimerSigningKeyFile();
    await expect(mod.signContextToken(basePayload())).rejects.toThrow(
      /No active Aimer signing key/,
    );
  });
});
