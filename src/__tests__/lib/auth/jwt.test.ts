import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPoolQuery = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({
  query: vi.fn((...args: unknown[]) => mockPoolQuery(...args)),
}));

const tmpDir = path.join(__dirname, ".tmp-jwt");
const dataDir = path.join(tmpDir, "data");

describe("jwt", () => {
  let jwtKeys: typeof import("@/lib/auth/jwt-keys");
  let jwt: typeof import("@/lib/auth/jwt");

  beforeEach(async () => {
    mkdirSync(dataDir, { recursive: true });
    process.env.DATA_DIR = dataDir;
    mockPoolQuery.mockReset();

    jwtKeys = await import("@/lib/auth/jwt-keys");
    jwtKeys.resetKeyState();

    // Generate and load a key pair
    await jwtKeys.generateJwtSigningKey();
    await jwtKeys.loadSigningKeys();

    jwt = await import("@/lib/auth/jwt");
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── issueAccessToken ──────────────────────────────────────────

  describe("issueAccessToken", () => {
    it("returns a valid JWT string", async () => {
      const token = await jwt.issueAccessToken({
        accountId: "account-1",
        sessionId: "session-1",
        roles: ["admin"],
        tokenVersion: 0,
      });

      expect(typeof token).toBe("string");
      expect(token.split(".")).toHaveLength(3);
    });

    it("includes correct claims in the payload", async () => {
      const token = await jwt.issueAccessToken({
        accountId: "account-1",
        sessionId: "session-1",
        roles: ["admin", "viewer"],
        tokenVersion: 3,
      });

      const payload = decodeJwt(token);
      expect(payload.iss).toBe("aice-web-next");
      expect(payload.sub).toBe("account-1");
      expect(payload.aud).toBe("aice-web-next");
      expect(payload.sid).toBe("session-1");
      expect(payload.roles).toEqual(["admin", "viewer"]);
      expect(payload.token_version).toBe(3);
      expect(payload.kid).toBeDefined();
      expect(payload.iat).toBeDefined();
      expect(payload.exp).toBeDefined();
    });

    it("sets kid in the protected header", async () => {
      const token = await jwt.issueAccessToken({
        accountId: "account-1",
        sessionId: "session-1",
        roles: ["admin"],
        tokenVersion: 0,
      });

      const header = decodeProtectedHeader(token);
      expect(header.kid).toBeDefined();
      expect(header.alg).toBe("ES256");
    });

    it("clamps expiration to min 5 minutes", async () => {
      const token = await jwt.issueAccessToken({
        accountId: "account-1",
        sessionId: "session-1",
        roles: ["admin"],
        tokenVersion: 0,
        expirationMinutes: 1,
      });

      const payload = decodeJwt(token);
      const iat = payload.iat as number;
      const exp = payload.exp as number;
      const diffMinutes = (exp - iat) / 60;
      expect(diffMinutes).toBeCloseTo(5, 0);
    });

    it("clamps expiration to max 15 minutes", async () => {
      const token = await jwt.issueAccessToken({
        accountId: "account-1",
        sessionId: "session-1",
        roles: ["admin"],
        tokenVersion: 0,
        expirationMinutes: 60,
      });

      const payload = decodeJwt(token);
      const iat = payload.iat as number;
      const exp = payload.exp as number;
      const diffMinutes = (exp - iat) / 60;
      expect(diffMinutes).toBeCloseTo(15, 0);
    });

    it("uses default 15 minute expiration", async () => {
      const token = await jwt.issueAccessToken({
        accountId: "account-1",
        sessionId: "session-1",
        roles: ["admin"],
        tokenVersion: 0,
      });

      const payload = decodeJwt(token);
      const iat = payload.iat as number;
      const exp = payload.exp as number;
      const diffMinutes = (exp - iat) / 60;
      expect(diffMinutes).toBeCloseTo(15, 0);
    });
  });

  // ── verifyJwtFull ─────────────────────────────────────────────

  describe("verifyJwtFull", () => {
    const validDbRow = {
      sid: "session-1",
      revoked: false,
      token_version: 0,
      status: "active",
      must_change_password: false,
    };

    async function issueValidToken() {
      return jwt.issueAccessToken({
        accountId: "account-1",
        sessionId: "session-1",
        roles: ["admin"],
        tokenVersion: 0,
      });
    }

    it("returns AuthSession on valid token with valid DB state", async () => {
      const token = await issueValidToken();
      mockPoolQuery.mockResolvedValueOnce({ rows: [validDbRow] });

      const session = await jwt.verifyJwtFull(token);

      expect(session.accountId).toBe("account-1");
      expect(session.sessionId).toBe("session-1");
      expect(session.roles).toEqual(["admin"]);
      expect(session.tokenVersion).toBe(0);
      expect(session.mustChangePassword).toBe(false);
      expect(session.iat).toEqual(expect.any(Number));
    });

    it("includes mustChangePassword from DB", async () => {
      const token = await issueValidToken();
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ ...validDbRow, must_change_password: true }],
      });

      const session = await jwt.verifyJwtFull(token);
      expect(session.mustChangePassword).toBe(true);
    });

    it("throws when session is not found in DB", async () => {
      const token = await issueValidToken();
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      await expect(jwt.verifyJwtFull(token)).rejects.toThrow(
        "Session not found",
      );
    });

    it("throws when session is revoked", async () => {
      const token = await issueValidToken();
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ ...validDbRow, revoked: true }],
      });

      await expect(jwt.verifyJwtFull(token)).rejects.toThrow(
        "Session has been revoked",
      );
    });

    it("throws when account is not active", async () => {
      const token = await issueValidToken();
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ ...validDbRow, status: "disabled" }],
      });

      await expect(jwt.verifyJwtFull(token)).rejects.toThrow(
        "Account is not active",
      );
    });

    it("throws when token version mismatches", async () => {
      const token = await issueValidToken();
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ ...validDbRow, token_version: 99 }],
      });

      await expect(jwt.verifyJwtFull(token)).rejects.toThrow(
        "Token version mismatch",
      );
    });

    it("throws on expired token", async () => {
      // Issue a token, then manipulate the clock
      const token = await issueValidToken();

      // Advance time beyond expiration
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 20 * 60 * 1000);

      await expect(jwt.verifyJwtFull(token)).rejects.toThrow();

      vi.useRealTimers();
    });

    it("throws on completely invalid token", async () => {
      await expect(jwt.verifyJwtFull("not.a.jwt")).rejects.toThrow();
    });

    it("throws when kid is missing from header", async () => {
      // Create a manually crafted token without kid using jose
      const { SignJWT } = await import("jose");
      const { generateKeyPair } = await import("jose");
      const { privateKey } = await generateKeyPair("ES256");

      const token = await new SignJWT({ sid: "s", roles: [] })
        .setProtectedHeader({ alg: "ES256" }) // No kid
        .setSubject("acc")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);

      await expect(jwt.verifyJwtFull(token)).rejects.toThrow(
        "JWT header missing kid",
      );
    });

    it("throws when kid does not match any known key", async () => {
      // Create a token signed with a different key
      const { SignJWT, generateKeyPair } = await import("jose");
      const { privateKey } = await generateKeyPair("ES256");

      const token = await new SignJWT({ sid: "s", roles: [] })
        .setProtectedHeader({ alg: "ES256", kid: "unknown-kid" })
        .setSubject("acc")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);

      await expect(jwt.verifyJwtFull(token)).rejects.toThrow(
        "No verification key found",
      );
    });

    it("executes correct JOIN query", async () => {
      const token = await issueValidToken();
      mockPoolQuery.mockResolvedValueOnce({ rows: [validDbRow] });

      await jwt.verifyJwtFull(token);

      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining("JOIN accounts a ON"),
        ["session-1", "account-1"],
      );
    });
  });
});
