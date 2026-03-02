import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const tmpDir = path.join(__dirname, ".tmp-jwt-keys");
const dataDir = path.join(tmpDir, "data");

describe("jwt-keys", () => {
  let jwtKeys: typeof import("@/lib/auth/jwt-keys");

  beforeEach(async () => {
    mkdirSync(dataDir, { recursive: true });
    process.env.DATA_DIR = dataDir;

    // Fresh module per test
    const mod = await import("@/lib/auth/jwt-keys");
    jwtKeys = mod;
    jwtKeys.resetKeyState();
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── generateJwtSigningKey ─────────────────────────────────────

  describe("generateJwtSigningKey", () => {
    it("writes a key file to disk", async () => {
      await jwtKeys.generateJwtSigningKey();

      const keyPath = path.join(dataDir, "keys", "jwt-signing.json");
      expect(existsSync(keyPath)).toBe(true);

      const keyFile = JSON.parse(readFileSync(keyPath, "utf8"));
      expect(keyFile.kid).toBeDefined();
      expect(keyFile.algorithm).toBe("ES256");
      expect(keyFile.privateKey).toBeDefined();
      expect(keyFile.publicKey).toBeDefined();
    });

    it("creates the keys directory if it does not exist", async () => {
      const keysDir = path.join(dataDir, "keys");
      expect(existsSync(keysDir)).toBe(false);

      await jwtKeys.generateJwtSigningKey();

      expect(existsSync(keysDir)).toBe(true);
    });
  });

  // ── loadSigningKeys ───────────────────────────────────────────

  describe("loadSigningKeys", () => {
    it("loads a generated key file", async () => {
      await jwtKeys.generateJwtSigningKey();
      jwtKeys.resetKeyState();

      await jwtKeys.loadSigningKeys();

      const key = jwtKeys.getSigningKey();
      expect(key.kid).toBeDefined();
      expect(key.algorithm).toBe("ES256");
      expect(key.privateKey).toBeDefined();
      expect(key.publicKey).toBeDefined();
    });

    it("throws when key file is missing", async () => {
      await expect(jwtKeys.loadSigningKeys()).rejects.toThrow(
        /JWT signing key not found/,
      );
    });

    it("loads previous key when present", async () => {
      // Generate first key
      await jwtKeys.generateJwtSigningKey();
      const currentKeyPath = path.join(dataDir, "keys", "jwt-signing.json");
      const prevKeyPath = path.join(dataDir, "keys", "jwt-signing.prev.json");

      // Copy current to prev and generate new current
      const firstKey = readFileSync(currentKeyPath, "utf8");
      writeFileSync(prevKeyPath, firstKey, "utf8");
      await jwtKeys.generateJwtSigningKey();

      jwtKeys.resetKeyState();
      await jwtKeys.loadSigningKeys();

      const firstKid = JSON.parse(firstKey).kid;
      const verificationKey = jwtKeys.getVerificationKey(firstKid);
      expect(verificationKey).not.toBeNull();
      expect(verificationKey?.algorithm).toBe("ES256");
    });

    it("works without a previous key file", async () => {
      await jwtKeys.generateJwtSigningKey();
      jwtKeys.resetKeyState();

      await jwtKeys.loadSigningKeys();

      // Should not throw, previous key is optional
      const key = jwtKeys.getSigningKey();
      expect(key).toBeDefined();
    });
  });

  // ── getSigningKey ─────────────────────────────────────────────

  describe("getSigningKey", () => {
    it("throws when keys are not loaded", () => {
      expect(() => jwtKeys.getSigningKey()).toThrow(
        /JWT signing keys not loaded/,
      );
    });

    it("returns the current key after loading", async () => {
      await jwtKeys.generateJwtSigningKey();
      jwtKeys.resetKeyState();
      await jwtKeys.loadSigningKeys();

      const key = jwtKeys.getSigningKey();
      expect(key.kid).toBeDefined();
      expect(key.privateKey).toBeDefined();
    });
  });

  // ── getVerificationKey ────────────────────────────────────────

  describe("getVerificationKey", () => {
    it("returns current key by kid", async () => {
      await jwtKeys.generateJwtSigningKey();
      jwtKeys.resetKeyState();
      await jwtKeys.loadSigningKeys();

      const key = jwtKeys.getSigningKey();
      const verificationKey = jwtKeys.getVerificationKey(key.kid);
      expect(verificationKey).not.toBeNull();
      expect(verificationKey?.publicKey).toBeDefined();
    });

    it("returns previous key by kid", async () => {
      // Setup: current → prev, then new current
      await jwtKeys.generateJwtSigningKey();
      const currentKeyPath = path.join(dataDir, "keys", "jwt-signing.json");
      const prevKeyPath = path.join(dataDir, "keys", "jwt-signing.prev.json");

      const firstKeyData = readFileSync(currentKeyPath, "utf8");
      const firstKid = JSON.parse(firstKeyData).kid;
      writeFileSync(prevKeyPath, firstKeyData, "utf8");

      await jwtKeys.generateJwtSigningKey();
      jwtKeys.resetKeyState();
      await jwtKeys.loadSigningKeys();

      const verificationKey = jwtKeys.getVerificationKey(firstKid);
      expect(verificationKey).not.toBeNull();
    });

    it("returns null for unknown kid", async () => {
      await jwtKeys.generateJwtSigningKey();
      jwtKeys.resetKeyState();
      await jwtKeys.loadSigningKeys();

      const result = jwtKeys.getVerificationKey("unknown-kid");
      expect(result).toBeNull();
    });
  });

  // ── getPublicKeyData ──────────────────────────────────────────

  describe("getPublicKeyData", () => {
    it("returns current key data", async () => {
      await jwtKeys.generateJwtSigningKey();

      const data = jwtKeys.getPublicKeyData();
      expect(data).toHaveLength(1);
      expect(data[0].kid).toBeDefined();
      expect(data[0].algorithm).toBe("ES256");
      expect(data[0].publicKey).toBeDefined();
    });

    it("returns both current and previous key data", async () => {
      await jwtKeys.generateJwtSigningKey();
      const currentKeyPath = path.join(dataDir, "keys", "jwt-signing.json");
      const prevKeyPath = path.join(dataDir, "keys", "jwt-signing.prev.json");

      const firstKey = readFileSync(currentKeyPath, "utf8");
      writeFileSync(prevKeyPath, firstKey, "utf8");
      await jwtKeys.generateJwtSigningKey();

      const data = jwtKeys.getPublicKeyData();
      expect(data).toHaveLength(2);
      expect(data[0].kid).not.toBe(data[1].kid);
    });

    it("returns empty array when no keys exist", async () => {
      const data = jwtKeys.getPublicKeyData();
      expect(data).toHaveLength(0);
    });
  });

  // ── removePreviousKey ─────────────────────────────────────────

  describe("removePreviousKey", () => {
    it("deletes the previous key file from disk", async () => {
      await jwtKeys.generateJwtSigningKey();
      const currentKeyPath = path.join(dataDir, "keys", "jwt-signing.json");
      const prevKeyPath = path.join(dataDir, "keys", "jwt-signing.prev.json");

      writeFileSync(prevKeyPath, readFileSync(currentKeyPath, "utf8"), "utf8");
      expect(existsSync(prevKeyPath)).toBe(true);

      jwtKeys.removePreviousKey();

      expect(existsSync(prevKeyPath)).toBe(false);
    });

    it("does not throw when previous key file does not exist", () => {
      expect(() => jwtKeys.removePreviousKey()).not.toThrow();
    });

    it("clears previous key from memory after removal", async () => {
      // Setup: generate key, copy to prev, generate new, load both
      await jwtKeys.generateJwtSigningKey();
      const currentKeyPath = path.join(dataDir, "keys", "jwt-signing.json");
      const prevKeyPath = path.join(dataDir, "keys", "jwt-signing.prev.json");

      const firstKeyData = readFileSync(currentKeyPath, "utf8");
      const firstKid = JSON.parse(firstKeyData).kid;
      writeFileSync(prevKeyPath, firstKeyData, "utf8");
      await jwtKeys.generateJwtSigningKey();

      jwtKeys.resetKeyState();
      await jwtKeys.loadSigningKeys();

      // Verify previous key is loaded
      expect(jwtKeys.getVerificationKey(firstKid)).not.toBeNull();

      // Remove and verify it's cleared
      jwtKeys.removePreviousKey();
      expect(jwtKeys.getVerificationKey(firstKid)).toBeNull();
    });
  });

  // ── key rotation flow ─────────────────────────────────────────

  describe("key rotation flow", () => {
    it("supports current → prev rotation with both keys resolvable", async () => {
      // Generate first key
      await jwtKeys.generateJwtSigningKey();
      const currentKeyPath = path.join(dataDir, "keys", "jwt-signing.json");
      const prevKeyPath = path.join(dataDir, "keys", "jwt-signing.prev.json");

      const firstKeyData = JSON.parse(readFileSync(currentKeyPath, "utf8"));

      // Rotate: move current to prev, generate new current
      writeFileSync(prevKeyPath, JSON.stringify(firstKeyData, null, 2), "utf8");
      await jwtKeys.generateJwtSigningKey();

      jwtKeys.resetKeyState();
      await jwtKeys.loadSigningKeys();

      const currentKey = jwtKeys.getSigningKey();
      const newKid = currentKey.kid;
      const oldKid = firstKeyData.kid;

      // Both kids should be different
      expect(newKid).not.toBe(oldKid);

      // Both should resolve
      expect(jwtKeys.getVerificationKey(newKid)).not.toBeNull();
      expect(jwtKeys.getVerificationKey(oldKid)).not.toBeNull();
    });
  });
});
