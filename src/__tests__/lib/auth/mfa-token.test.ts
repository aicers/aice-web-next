import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { decodeJwt } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({
  query: vi.fn(),
}));

const tmpDir = path.join(__dirname, ".tmp-mfa-token");
const dataDir = path.join(tmpDir, "data");

describe("mfa-token", () => {
  let jwtKeys: typeof import("@/lib/auth/jwt-keys");
  let mfaToken: typeof import("@/lib/auth/mfa-token");

  beforeEach(async () => {
    mkdirSync(dataDir, { recursive: true });
    process.env.DATA_DIR = dataDir;

    jwtKeys = await import("@/lib/auth/jwt-keys");
    jwtKeys.resetKeyState();

    await jwtKeys.generateJwtSigningKey();
    await jwtKeys.loadSigningKeys();

    mfaToken = await import("@/lib/auth/mfa-token");
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── issueMfaToken ─────────────────────────────────────────────

  describe("issueMfaToken", () => {
    it("returns a valid JWT string", async () => {
      const token = await mfaToken.issueMfaToken({
        accountId: "account-1",
        roles: ["admin"],
        tokenVersion: 0,
        jti: "test-jti-123",
      });

      expect(typeof token).toBe("string");
      expect(token.split(".")).toHaveLength(3);
    });

    it("includes correct claims in the payload", async () => {
      const token = await mfaToken.issueMfaToken({
        accountId: "account-1",
        roles: ["admin"],
        tokenVersion: 42,
        jti: "jti-abc",
      });

      const payload = decodeJwt(token);

      expect(payload.sub).toBe("account-1");
      expect(payload.jti).toBe("jti-abc");
      expect(payload.roles).toEqual(["admin"]);
      expect(payload.token_version).toBe(42);
      expect(payload.purpose).toBe("mfa_challenge");
      expect(payload.iss).toBe("aice-web-next");
      expect(payload.aud).toBe("aice-web-next");
    });

    it("sets expiration to approximately 5 minutes", async () => {
      const before = Math.floor(Date.now() / 1000);

      const token = await mfaToken.issueMfaToken({
        accountId: "account-1",
        roles: ["admin"],
        tokenVersion: 0,
        jti: "jti-exp-test",
      });

      const payload = decodeJwt(token);
      const after = Math.floor(Date.now() / 1000);

      // exp should be iat + 300 (5 minutes)
      expect(Number(payload.exp) - Number(payload.iat)).toBe(300);
      expect(payload.iat).toBeGreaterThanOrEqual(before);
      expect(payload.iat).toBeLessThanOrEqual(after);
    });
  });

  // ── verifyMfaToken ────────────────────────────────────────────

  describe("verifyMfaToken", () => {
    it("succeeds for a freshly issued token", async () => {
      const token = await mfaToken.issueMfaToken({
        accountId: "account-1",
        roles: ["admin"],
        tokenVersion: 5,
        jti: "jti-verify-test",
      });

      const payload = await mfaToken.verifyMfaToken(token);

      expect(payload.sub).toBe("account-1");
      expect(payload.jti).toBe("jti-verify-test");
      expect(payload.roles).toEqual(["admin"]);
      expect(payload.token_version).toBe(5);
      expect(payload.purpose).toBe("mfa_challenge");
    });

    it("rejects a tampered token", async () => {
      const token = await mfaToken.issueMfaToken({
        accountId: "account-1",
        roles: ["admin"],
        tokenVersion: 0,
        jti: "jti-tamper",
      });

      // Tamper with the payload
      const parts = token.split(".");
      parts[1] = `${parts[1]}x`;
      const tampered = parts.join(".");

      await expect(mfaToken.verifyMfaToken(tampered)).rejects.toThrow();
    });

    it("rejects a token after the signing key is replaced", async () => {
      const token = await mfaToken.issueMfaToken({
        accountId: "account-1",
        roles: ["admin"],
        tokenVersion: 0,
        jti: "jti-diffkey",
      });

      // Replace the signing key entirely (no previous key preserved)
      await jwtKeys.generateJwtSigningKey();
      jwtKeys.resetKeyState();
      await jwtKeys.loadSigningKeys();

      // Verification should fail because the old kid is unknown
      await expect(mfaToken.verifyMfaToken(token)).rejects.toThrow(
        /No verification key found/,
      );
    });
  });
});
