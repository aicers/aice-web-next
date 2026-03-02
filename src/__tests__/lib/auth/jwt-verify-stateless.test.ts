import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tmpDir = path.join(__dirname, ".tmp-jwt-stateless");
const dataDir = path.join(tmpDir, "data");

describe("jwt-verify-stateless", () => {
  let jwtKeys: typeof import("@/lib/auth/jwt-keys");
  let jwt: typeof import("@/lib/auth/jwt");
  let stateless: typeof import("@/lib/auth/jwt-verify-stateless");

  // Mock DB for jwt.ts (issueAccessToken doesn't use DB, but module imports it)
  const mockPoolQuery = vi.hoisted(() => vi.fn());

  vi.mock("@/lib/db/client", () => ({
    query: vi.fn((...args: unknown[]) => mockPoolQuery(...args)),
  }));

  beforeEach(async () => {
    mkdirSync(dataDir, { recursive: true });
    process.env.DATA_DIR = dataDir;

    jwtKeys = await import("@/lib/auth/jwt-keys");
    jwtKeys.resetKeyState();

    await jwtKeys.generateJwtSigningKey();
    await jwtKeys.loadSigningKeys();

    jwt = await import("@/lib/auth/jwt");
    stateless = await import("@/lib/auth/jwt-verify-stateless");

    // Initialize stateless keys from the loaded key data
    const publicKeyData = jwtKeys.getPublicKeyData();
    await stateless.initStatelessKeys(publicKeyData);
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── verifyJwtStateless ────────────────────────────────────────

  describe("verifyJwtStateless", () => {
    it("verifies a valid token and returns payload", async () => {
      const token = await jwt.issueAccessToken({
        accountId: "account-1",
        sessionId: "session-1",
        roles: ["admin"],
        tokenVersion: 0,
      });

      const payload = await stateless.verifyJwtStateless(token);

      expect(payload.sub).toBe("account-1");
      expect(payload.sid).toBe("session-1");
      expect(payload.roles).toEqual(["admin"]);
      expect(payload.token_version).toBe(0);
      expect(payload.kid).toBeDefined();
    });

    it("throws on expired token", async () => {
      const token = await jwt.issueAccessToken({
        accountId: "account-1",
        sessionId: "session-1",
        roles: ["admin"],
        tokenVersion: 0,
      });

      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 20 * 60 * 1000);

      await expect(stateless.verifyJwtStateless(token)).rejects.toThrow();

      vi.useRealTimers();
    });

    it("throws when kid does not match any initialized key", async () => {
      const { SignJWT, generateKeyPair } = await import("jose");
      const { privateKey } = await generateKeyPair("ES256");

      const token = await new SignJWT({
        sid: "s",
        roles: [],
        token_version: 0,
        kid: "unknown-kid",
      })
        .setProtectedHeader({ alg: "ES256", kid: "unknown-kid" })
        .setIssuer("aice-web-next")
        .setSubject("acc")
        .setAudience("aice-web-next")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);

      await expect(stateless.verifyJwtStateless(token)).rejects.toThrow(
        "No verification key found",
      );
    });

    it("throws when kid is missing from header", async () => {
      const { SignJWT, generateKeyPair } = await import("jose");
      const { privateKey } = await generateKeyPair("ES256");

      const token = await new SignJWT({ sid: "s", roles: [] })
        .setProtectedHeader({ alg: "ES256" })
        .setSubject("acc")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);

      await expect(stateless.verifyJwtStateless(token)).rejects.toThrow(
        "JWT header missing kid",
      );
    });

    it("throws on tampered token (wrong signature)", async () => {
      const token = await jwt.issueAccessToken({
        accountId: "account-1",
        sessionId: "session-1",
        roles: ["admin"],
        tokenVersion: 0,
      });

      // Tamper with the signature part
      const parts = token.split(".");
      parts[2] = `${parts[2]}tampered`;
      const tamperedToken = parts.join(".");

      await expect(
        stateless.verifyJwtStateless(tamperedToken),
      ).rejects.toThrow();
    });
  });

  // ── multiple keys (rotation) ──────────────────────────────────

  describe("key rotation support", () => {
    it("verifies tokens signed with both current and previous keys", async () => {
      // Issue a token with the first key
      const tokenWithFirstKey = await jwt.issueAccessToken({
        accountId: "account-1",
        sessionId: "session-1",
        roles: ["admin"],
        tokenVersion: 0,
      });

      // Rotate: save current key file as prev, generate new
      const { readFileSync, writeFileSync } = await import("node:fs");
      const currentKeyPath = path.join(dataDir, "keys", "jwt-signing.json");
      const prevKeyPath = path.join(dataDir, "keys", "jwt-signing.prev.json");

      writeFileSync(prevKeyPath, readFileSync(currentKeyPath, "utf8"), "utf8");
      await jwtKeys.generateJwtSigningKey();
      jwtKeys.resetKeyState();
      await jwtKeys.loadSigningKeys();

      // Issue a token with the new key
      const tokenWithNewKey = await jwt.issueAccessToken({
        accountId: "account-2",
        sessionId: "session-2",
        roles: ["viewer"],
        tokenVersion: 1,
      });

      // Re-init stateless keys with both
      await stateless.initStatelessKeys(jwtKeys.getPublicKeyData());

      // Both tokens should verify
      const payload1 = await stateless.verifyJwtStateless(tokenWithFirstKey);
      expect(payload1.sub).toBe("account-1");

      const payload2 = await stateless.verifyJwtStateless(tokenWithNewKey);
      expect(payload2.sub).toBe("account-2");
    });
  });
});
