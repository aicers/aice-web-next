import { decodeJwt, decodeProtectedHeader, importSPKI, jwtVerify } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EC256_CERT,
  EC256_KEY,
  EC384_CERT,
  EC384_KEY,
  RSA_CERT,
  RSA_KEY,
  RSA3072_CERT,
  RSA3072_KEY,
  RSA4096_CERT,
  RSA4096_KEY,
} from "./fixtures";

const fileStore: Record<string, string> = {};

vi.mock("node:fs", () => ({
  readFileSync: vi.fn((filePath: string) => {
    if (filePath in fileStore) return fileStore[filePath];
    throw new Error(`ENOENT: no such file ${filePath}`);
  }),
}));

function setEnv(certPem: string, keyPem: string) {
  process.env.MTLS_CERT_PATH = "/tmp/cert.pem";
  process.env.MTLS_KEY_PATH = "/tmp/key.pem";
  process.env.MTLS_CA_PATH = "/tmp/ca.pem";

  for (const key of Object.keys(fileStore)) delete fileStore[key];
  Object.assign(fileStore, {
    "/tmp/cert.pem": certPem,
    "/tmp/key.pem": keyPem,
    "/tmp/ca.pem": certPem,
  });
}

function clearEnv() {
  delete process.env.MTLS_CERT_PATH;
  delete process.env.MTLS_KEY_PATH;
  delete process.env.MTLS_CA_PATH;
  for (const key of Object.keys(fileStore)) delete fileStore[key];
}

function publicKeyFromCert(certPem: string): string {
  const { X509Certificate } = require("node:crypto");
  const x509 = new X509Certificate(certPem);
  return x509.publicKey.export({ type: "spki", format: "pem" }) as string;
}

describe("mtls", () => {
  let mtls: typeof import("@/lib/mtls");

  beforeEach(async () => {
    vi.resetModules();
    mtls = await import("@/lib/mtls");
  });

  afterEach(clearEnv);

  // ── detectAlgorithm ──────────────────────────────────────────────

  describe("detectAlgorithm", () => {
    it("returns RS256 for RSA 2048 certificate", () => {
      expect(mtls.detectAlgorithm(RSA_CERT)).toBe("RS256");
    });

    it("returns RS384 for RSA 3072 certificate", () => {
      expect(mtls.detectAlgorithm(RSA3072_CERT)).toBe("RS384");
    });

    it("returns RS512 for RSA 4096 certificate", () => {
      expect(mtls.detectAlgorithm(RSA4096_CERT)).toBe("RS512");
    });

    it("returns ES256 for EC P-256 certificate", () => {
      expect(mtls.detectAlgorithm(EC256_CERT)).toBe("ES256");
    });

    it("returns ES384 for EC P-384 certificate", () => {
      expect(mtls.detectAlgorithm(EC384_CERT)).toBe("ES384");
    });
  });

  // ── signContextJwt ───────────────────────────────────────────────

  describe("signContextJwt", () => {
    it("includes role and customer_ids in payload", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      const token = await mtls.signContextJwt("System Administrator", [42, 99]);
      const payload = decodeJwt(token);

      expect(payload.role).toBe("System Administrator");
      expect(payload.customer_ids).toEqual([42, 99]);
    });

    it("omits customer_ids when not provided", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      const token = await mtls.signContextJwt("System Administrator");
      const payload = decodeJwt(token);

      expect(payload.role).toBe("System Administrator");
      expect(payload).not.toHaveProperty("customer_ids");
    });

    it("includes customer_ids as empty array when passed []", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      const token = await mtls.signContextJwt("Security Administrator", []);
      const payload = decodeJwt(token);

      expect(payload.customer_ids).toEqual([]);
    });

    it("sets exp claim approximately 5 minutes from now", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      const before = Math.floor(Date.now() / 1000);
      const token = await mtls.signContextJwt("System Administrator");
      const after = Math.floor(Date.now() / 1000);
      const payload = decodeJwt(token);

      expect(payload.exp).toBeTypeOf("number");
      const exp = payload.exp as number;
      expect(exp).toBeGreaterThanOrEqual(before + 295);
      expect(exp).toBeLessThanOrEqual(after + 305);
    });

    it("does not include unexpected claims", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      const token = await mtls.signContextJwt("System Administrator", [42]);
      const payload = decodeJwt(token);

      for (const k of Object.keys(payload)) {
        expect(["role", "customer_ids", "exp", "iat"]).toContain(k);
      }
    });

    // Algorithm selection per key type

    it("signs with RS256 for RSA 2048 key", async () => {
      setEnv(RSA_CERT, RSA_KEY);
      const token = await mtls.signContextJwt("admin");
      expect(decodeProtectedHeader(token).alg).toBe("RS256");
    });

    it("signs with RS384 for RSA 3072 key", async () => {
      setEnv(RSA3072_CERT, RSA3072_KEY);
      const token = await mtls.signContextJwt("admin");
      expect(decodeProtectedHeader(token).alg).toBe("RS384");
    });

    it("signs with RS512 for RSA 4096 key", async () => {
      setEnv(RSA4096_CERT, RSA4096_KEY);
      const token = await mtls.signContextJwt("admin");
      expect(decodeProtectedHeader(token).alg).toBe("RS512");
    });

    it("signs with ES256 for EC P-256 key", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      const token = await mtls.signContextJwt("admin");
      expect(decodeProtectedHeader(token).alg).toBe("ES256");
    });

    it("signs with ES384 for EC P-384 key", async () => {
      setEnv(EC384_CERT, EC384_KEY);
      const token = await mtls.signContextJwt("admin");
      expect(decodeProtectedHeader(token).alg).toBe("ES384");
    });

    // Signature verification — mimics what review-web does

    it("JWT verifiable with EC P-256 certificate public key", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      const token = await mtls.signContextJwt("System Administrator", [42]);
      const pubKey = await importSPKI(publicKeyFromCert(EC256_CERT), "ES256");
      const { payload } = await jwtVerify(token, pubKey);

      expect(payload.role).toBe("System Administrator");
      expect(payload.customer_ids).toEqual([42]);
    });

    it("JWT verifiable with EC P-384 certificate public key", async () => {
      setEnv(EC384_CERT, EC384_KEY);
      const token = await mtls.signContextJwt("System Administrator", [1]);
      const pubKey = await importSPKI(publicKeyFromCert(EC384_CERT), "ES384");
      const { payload } = await jwtVerify(token, pubKey);

      expect(payload.role).toBe("System Administrator");
    });

    it("JWT verifiable with RSA 2048 certificate public key", async () => {
      setEnv(RSA_CERT, RSA_KEY);
      const token = await mtls.signContextJwt("System Administrator");
      const pubKey = await importSPKI(publicKeyFromCert(RSA_CERT), "RS256");
      const { payload } = await jwtVerify(token, pubKey);

      expect(payload.role).toBe("System Administrator");
    });

    it("JWT NOT verifiable with wrong certificate", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      const token = await mtls.signContextJwt("admin");
      const wrongPubKey = await importSPKI(
        publicKeyFromCert(EC384_CERT),
        "ES384",
      );

      await expect(jwtVerify(token, wrongPubKey)).rejects.toThrow();
    });

    it("produces fresh token each call", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      const token1 = await mtls.signContextJwt("admin");
      await new Promise((r) => setTimeout(r, 10));
      const token2 = await mtls.signContextJwt("admin");

      expect(token1).not.toBe(token2);
    });
  });

  // ── getAgent ─────────────────────────────────────────────────────

  describe("getAgent", () => {
    it("returns an Agent on successful initialization", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      const agent = await mtls.getAgent();
      expect(agent).toBeDefined();
      expect(agent.constructor.name).toBe("Agent");
    });

    it("returns same Agent on repeated calls (lazy singleton)", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      const agent1 = await mtls.getAgent();
      const agent2 = await mtls.getAgent();
      expect(agent1).toBe(agent2);
    });
  });

  // ── reload ───────────────────────────────────────────────────────

  describe("reload", () => {
    it("returns a different Agent instance", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      const agent1 = await mtls.getAgent();
      const agent2 = await mtls.reload();
      expect(agent2).not.toBe(agent1);
    });

    it("subsequent getAgent returns the reloaded Agent", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      await mtls.getAgent();
      const reloaded = await mtls.reload();
      const current = await mtls.getAgent();
      expect(current).toBe(reloaded);
    });

    it("uses new key material after reload", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      const token1 = await mtls.signContextJwt("admin");
      expect(decodeProtectedHeader(token1).alg).toBe("ES256");

      setEnv(RSA_CERT, RSA_KEY);
      await mtls.reload();
      const token2 = await mtls.signContextJwt("admin");
      expect(decodeProtectedHeader(token2).alg).toBe("RS256");
    });
  });

  // ── error handling ───────────────────────────────────────────────

  describe("error handling", () => {
    it("throws when MTLS_CERT_PATH is missing", async () => {
      delete process.env.MTLS_CERT_PATH;
      process.env.MTLS_KEY_PATH = "/tmp/key.pem";
      process.env.MTLS_CA_PATH = "/tmp/ca.pem";

      await expect(mtls.getAgent()).rejects.toThrow(
        "Missing environment variable: MTLS_CERT_PATH",
      );
    });

    it("throws when MTLS_KEY_PATH is missing", async () => {
      process.env.MTLS_CERT_PATH = "/tmp/cert.pem";
      delete process.env.MTLS_KEY_PATH;
      process.env.MTLS_CA_PATH = "/tmp/ca.pem";
      Object.assign(fileStore, {
        "/tmp/cert.pem": EC256_CERT,
        "/tmp/ca.pem": EC256_CERT,
      });

      await expect(mtls.getAgent()).rejects.toThrow(
        "Missing environment variable: MTLS_KEY_PATH",
      );
    });

    it("throws when MTLS_CA_PATH is missing", async () => {
      process.env.MTLS_CERT_PATH = "/tmp/cert.pem";
      process.env.MTLS_KEY_PATH = "/tmp/key.pem";
      delete process.env.MTLS_CA_PATH;
      Object.assign(fileStore, {
        "/tmp/cert.pem": EC256_CERT,
        "/tmp/key.pem": EC256_KEY,
      });

      await expect(mtls.getAgent()).rejects.toThrow(
        "Missing environment variable: MTLS_CA_PATH",
      );
    });

    it("throws descriptive error when cert file does not exist", async () => {
      process.env.MTLS_CERT_PATH = "/nonexistent/cert.pem";
      process.env.MTLS_KEY_PATH = "/tmp/key.pem";
      process.env.MTLS_CA_PATH = "/tmp/ca.pem";

      await expect(mtls.getAgent()).rejects.toThrow(
        "ENOENT: no such file /nonexistent/cert.pem",
      );
    });

    it("signContextJwt also triggers lazy init and can fail", async () => {
      delete process.env.MTLS_CERT_PATH;
      process.env.MTLS_KEY_PATH = "/tmp/key.pem";
      process.env.MTLS_CA_PATH = "/tmp/ca.pem";

      await expect(mtls.signContextJwt("admin")).rejects.toThrow(
        "Missing environment variable: MTLS_CERT_PATH",
      );
    });
  });
});
